package expo.modules.crishasr

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * Crish 离线语音识别原生模块（sherpa-onnx 1.13.8 官方 AAR）。
 *
 * 定位：只提供低层原语——引擎创建/释放、VAD 操作、单次解码、麦克风采集；
 * 伪流式状态机（pre-roll / 200ms partial 节律 / flush 收尾）在 TS 层实现，
 * 与节点侧 harness 共用同一份管线代码，保证行为可测、可复现。
 *
 * 规范参数（用户引擎规范 2026-11-01，锁定）：
 * - Recognizer：SenseVoice，language="auto"，use_itn=true，threads=2，cpu；
 * - VAD：threshold 0.5，min_silence 0.30，min_speech 0.25，max_speech 8.0，
 *   window 512，sample_rate 16000。（Kotlin API 未暴露 buffer_size_in_seconds，
 *   该项走原生默认；官方 SimulateStreamingAsr 示例同此用法。）
 * - 采集：16kHz / 单声道 / PCM16，帧经 onAudioChunk 以 base64 推送。
 */
class CrishAsrModule : Module() {

  private var recognizer: OfflineRecognizer? = null
  private var vad: Vad? = null
  private var recorder: AudioRecord? = null

  @Volatile
  private var capturing = false
  private var captureThread: Thread? = null

  override fun definition() = ModuleDefinition {
    Name("CrishAsr")

    Events("onAudioChunk", "onCaptureError")

    AsyncFunction("fileSha256") { filePath: String, promise: Promise ->
      thread(start = true, isDaemon = true, name = "crish-file-sha256") {
        try {
          val hash = calculateFileSha256(filePath)
          promise.resolve(hash)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: Throwable) {
          promise.reject(CodedException("FILE_SHA256_ERROR", e.message ?: "计算文件哈希失败", e))
        }
      }
    }

    AsyncFunction("createEngine") { modelPath: String, tokensPath: String, vadModelPath: String ->
      createEngineInternal(modelPath, tokensPath, vadModelPath)
    }

    AsyncFunction("destroyEngine") {
      destroyEngineInternal()
    }

    Function("vadAccept") { samplesB64: String ->
      requireVad().acceptWaveform(decodeFloat32(samplesB64))
    }

    Function("vadIsSpeechDetected") {
      requireVad().isSpeechDetected()
    }

    Function("vadIsEmpty") {
      requireVad().empty()
    }

    Function("vadFront") {
      val current = requireVad()
      if (current.empty()) {
        null
      } else {
        val segment = current.front()
        mapOf(
          "start" to segment.start,
          "samplesB64" to encodeFloat32(segment.samples)
        )
      }
    }

    Function("vadPop") {
      requireVad().pop()
    }

    Function("vadFlush") {
      requireVad().flush()
    }

    Function("vadReset") {
      requireVad().reset()
    }

    AsyncFunction("decode") { samplesB64: String ->
      decodeInternal(samplesB64)
    }

    AsyncFunction("startCapture") {
      startCaptureInternal()
    }

    Function("stopCapture") {
      stopCaptureInternal()
    }

    OnDestroy {
      destroyEngineInternal()
    }
  }

  // ── 引擎生命周期 ────────────────────────────────────────────────

  private fun createEngineInternal(modelPath: String, tokensPath: String, vadModelPath: String) {
    destroyEngineInternal()
    val createdRecognizer = OfflineRecognizer(
      config = OfflineRecognizerConfig(
        featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
        modelConfig = OfflineModelConfig(
          senseVoice = OfflineSenseVoiceModelConfig(
            model = modelPath,
            language = "auto",
            useInverseTextNormalization = true
          ),
          tokens = tokensPath,
          numThreads = 2,
          provider = "cpu",
          debug = false
        )
      )
    )
    try {
      vad = Vad(
        config = VadModelConfig(
          sileroVadModelConfig = SileroVadModelConfig(
            model = vadModelPath,
            threshold = 0.5f,
            minSilenceDuration = 0.3f,
            minSpeechDuration = 0.25f,
            windowSize = 512,
            maxSpeechDuration = 8.0f
          ),
          sampleRate = SAMPLE_RATE,
          numThreads = 1,
          provider = "cpu",
          debug = false
        )
      )
    } catch (error: Throwable) {
      createdRecognizer.release()
      throw error
    }
    recognizer = createdRecognizer
  }

  private fun destroyEngineInternal() {
    stopCaptureInternal()
    recognizer?.release()
    recognizer = null
    vad?.release()
    vad = null
  }

  private fun requireVad(): Vad =
    vad ?: throw CodedException("ASR_ENGINE_NOT_READY", "ASR 引擎尚未创建", null)

  private fun requireRecognizer(): OfflineRecognizer =
    recognizer ?: throw CodedException("ASR_ENGINE_NOT_READY", "ASR 引擎尚未创建", null)

  // ── 解码 ────────────────────────────────────────────────────────

  private fun decodeInternal(samplesB64: String): String {
    val current = requireRecognizer()
    val samples = decodeFloat32(samplesB64)
    val stream = current.createStream()
    try {
      stream.acceptWaveform(samples, SAMPLE_RATE)
      current.decode(stream)
      return current.getResult(stream).text.trim()
    } finally {
      stream.release()
    }
  }

  // ── 麦克风采集 ──────────────────────────────────────────────────

  private fun startCaptureInternal(): Boolean {
    if (capturing) return true
    val context = appContext.reactContext
    if (context == null) {
      sendEvent("onCaptureError", mapOf("message" to "录音环境不可用"))
      return false
    }
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      sendEvent("onCaptureError", mapOf("message" to "麦克风权限未授权"))
      return false
    }
    val minBufferSize = AudioRecord.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    val bufferSize = maxOf(minBufferSize, CAPTURE_BUFFER_SAMPLES * 2)
    val created = AudioRecord(
      MediaRecorder.AudioSource.MIC,
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSize
    )
    if (created.state != AudioRecord.STATE_INITIALIZED) {
      created.release()
      sendEvent("onCaptureError", mapOf("message" to "录音设备初始化失败"))
      return false
    }
    recorder = created
    capturing = true
    created.startRecording()
    captureThread = thread(start = true, isDaemon = true, name = "crish-asr-capture") {
      val shorts = ShortArray(CAPTURE_BUFFER_SAMPLES)
      val bytes = ByteArray(CAPTURE_BUFFER_SAMPLES * 2)
      while (capturing) {
        val read = created.read(shorts, 0, shorts.size)
        if (read > 0) {
          val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
          for (i in 0 until read) {
            buffer.putShort(shorts[i])
          }
          val data = Base64.encodeToString(bytes, 0, read * 2, Base64.NO_WRAP)
          sendEvent("onAudioChunk", mapOf("data" to data))
        } else if (read < 0) {
          break
        }
      }
    }
    return true
  }

  private fun stopCaptureInternal() {
    if (!capturing && recorder == null) return
    capturing = false
    try {
      captureThread?.join(500)
    } catch (_: InterruptedException) {
      // 释放路径不因等待中断失败
    }
    captureThread = null
    recorder?.let { current ->
      try {
        current.stop()
      } catch (_: IllegalStateException) {
        // 已停止时忽略
      }
      current.release()
    }
    recorder = null
  }

  // ── base64 / 采样换算 ───────────────────────────────────────────

  private fun decodeFloat32(base64: String): FloatArray {
    val bytes = Base64.decode(base64, Base64.NO_WRAP)
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    val out = FloatArray(bytes.size / 4)
    buffer.asFloatBuffer().get(out)
    return out
  }

  private fun encodeFloat32(samples: FloatArray): String {
    val buffer = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
    buffer.asFloatBuffer().put(samples)
    return Base64.encodeToString(buffer.array(), Base64.NO_WRAP)
  }

  // ── 文件哈希（SHA-256 原生加速）────────────────────────────────

  private fun calculateFileSha256(filePath: String): String {
    val nativePath = if (filePath.startsWith("file://")) filePath.substring(7) else filePath
    val file = File(nativePath)
    if (!file.exists() || !file.isFile) {
      throw CodedException("FILE_NOT_FOUND", "待校验文件不存在: $nativePath", null)
    }
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { fis ->
      val buffer = ByteArray(131072) // 128KB 高性能分块读取
      var read: Int
      while (fis.read(buffer).also { read = it } != -1) {
        digest.update(buffer, 0, read)
      }
    }
    val bytes = digest.digest()
    val sb = StringBuilder(bytes.size * 2)
    for (b in bytes) {
      sb.append(String.format("%02x", b))
    }
    return sb.toString()
  }

  companion object {
    private const val SAMPLE_RATE = 16000

    /** 单次采集读缓冲（1024 采样 = 64ms/帧） */
    private const val CAPTURE_BUFFER_SAMPLES = 1024
  }
}
