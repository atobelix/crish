package expo.modules.crishhaptics

import android.content.Context
import android.os.Build
import android.os.CombinedVibration
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.annotation.RequiresApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Crish 触觉反馈原生桥（最小面）：只提供 VibrationEffect 级原语——能力
 * 查询 / 单次脉冲 / 波形 / 取消；语义与强度口径的单一真源在 TS 门面
 * （adapters/platform/haptics.ts），本模块不持有任何用户偏好。
 *
 * 选型依据（华为 P40 Pro / API 31 实测，2026-11-03，dumpsys
 * vibrator_manager）：该机 VibratorInfo 的 capabilities=0、supportedEffects
 * 为空——HAL 不上报 CAP_AMPLITUDE_CONTROL，也无预定义 effect 支持声明；
 * 而 expo-haptics 在 Android 的映射把 selection 落成 50ms、impact 落成
 * ≈43ms 的脉冲（见 vibrator 历史记录中 com.crish.mobile 的条目），在启停
 * 迟滞的马达上读作「长嗡」。故手感口径改为短脉冲（6–25ms 量级）+
 * amplitude/时长双轨分档，经本桥直达 createOneShot / createWaveform：
 * amplitude 被 HAL 采纳时强度分档，忽略时时长差仍可感知；createPredefined
 * 因该机无支持声明不作主路径。
 *
 * 通道：API 31+ 走 VibratorManager + VibrationAttributes(USAGE_TOUCH)
 * （与系统触觉通道同口径）；26–30 走默认 Vibrator 的 effect 通道；
 * <26 回退旧式定时震动（无强度概念，仅时长）。
 */
class CrishHapticsModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("CrishHaptics")

    Function("capabilities") {
      val current = vibrator()
      mapOf(
        "sdkInt" to Build.VERSION.SDK_INT,
        "hasVibrator" to (current?.hasVibrator() ?: false),
        "hasAmplitudeControl" to
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            current?.hasAmplitudeControl() ?: false
          } else {
            false
          }
      )
    }

    Function("oneShot") { durationMs: Int, amplitude: Int ->
      fireOneShot(durationMs, amplitude)
    }

    Function("waveform") { timings: List<Int>, amplitudes: List<Int> ->
      fireWaveform(timings, amplitudes)
    }

    Function("cancel") {
      vibrator()?.cancel()
    }
  }

  // ── 震动器获取 ──────────────────────────────────────────────────

  private fun vibrator(): Vibrator? {
    val context = appContext.reactContext ?: return null
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val manager =
        context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
      manager?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
  }

  // ── 发声 ────────────────────────────────────────────────────────

  private fun fireOneShot(durationMs: Int, amplitude: Int): Boolean {
    val current = vibrator() ?: return false
    if (!current.hasVibrator() || durationMs <= 0) return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val effect =
        VibrationEffect.createOneShot(
          durationMs.toLong(),
          normalizeOneShotAmplitude(amplitude)
        )
      vibrateEffect(current, effect)
    } else {
      @Suppress("DEPRECATION")
      current.vibrate(durationMs.toLong())
    }
    return true
  }

  private fun fireWaveform(timings: List<Int>, amplitudes: List<Int>): Boolean {
    val current = vibrator() ?: return false
    if (!current.hasVibrator() || timings.isEmpty() || timings.size != amplitudes.size) {
      return false
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val effect =
        VibrationEffect.createWaveform(
          timings.map { it.toLong() }.toLongArray(),
          amplitudes.map { normalizeWaveformAmplitude(it) }.toIntArray(),
          -1
        )
      vibrateEffect(current, effect)
    } else {
      @Suppress("DEPRECATION")
      current.vibrate(timings.map { it.toLong() }.toLongArray(), -1)
    }
    return true
  }

  private fun vibrateEffect(vibrator: Vibrator, effect: VibrationEffect) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      vibrateEffectApi31(effect)
    } else {
      vibrator.vibrate(effect)
    }
  }

  /** API 31+：经 VibratorManager 发声并标注触觉用途（USAGE_TOUCH） */
  @RequiresApi(Build.VERSION_CODES.S)
  private fun vibrateEffectApi31(effect: VibrationEffect) {
    val context = appContext.reactContext ?: return
    val manager =
      context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        ?: return
    val attributes =
      VibrationAttributes.Builder()
        .setUsage(VibrationAttributes.USAGE_TOUCH)
        .build()
    manager.vibrate(CombinedVibration.createParallel(effect), attributes)
  }

  // ── amplitude 归一 ──────────────────────────────────────────────

  /** 单次脉冲：≤0 → 系统默认强度；其余钳到 1–255 */
  private fun normalizeOneShotAmplitude(amplitude: Int): Int =
    if (amplitude <= 0) {
      VibrationEffect.DEFAULT_AMPLITUDE
    } else {
      amplitude.coerceIn(1, 255)
    }

  /** 波形：0 = 停振段（保留）；负数 → 系统默认强度；正数钳到 255 */
  private fun normalizeWaveformAmplitude(amplitude: Int): Int =
    when {
      amplitude == 0 -> 0
      amplitude < 0 -> VibrationEffect.DEFAULT_AMPLITUDE
      else -> amplitude.coerceIn(1, 255)
    }
}
