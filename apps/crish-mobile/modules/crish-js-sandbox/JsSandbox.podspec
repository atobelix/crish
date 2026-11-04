Pod::Spec.new do |s|
  s.name           = 'JsSandbox'
  s.version        = '0.1.0'
  s.summary        = 'Isolated QuickJS runtime for model-written JavaScript'
  s.description    = 'Runs untrusted JavaScript in a fresh QuickJS runtime per call on its own thread'
  s.author         = 'Crish'
  s.homepage       = 'https://github.com/conex/conex'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'ios/**/*.{h,mm,swift}', 'cpp/**/*.{h,c,cpp}'
  s.preserve_paths = 'vendor/**/*'
  s.public_header_files = 'ios/JsSandboxRunner.h'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'GCC_C_LANGUAGE_STANDARD' => 'gnu11',
    'GCC_OPTIMIZATION_LEVEL' => '2',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/cpp" "$(PODS_TARGET_SRCROOT)/vendor/quickjs-ng"',
  }
end
