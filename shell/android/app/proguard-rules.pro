# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Crash reports with line numbers (Play de-obfuscates them with the mapping),
# without the original file names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# sherpa-onnx's native code reads its config classes' fields and builds its
# result class by name.
-keep class com.k2fsa.sherpa.onnx.** { *; }

# Capacitor reads its plugins' @CapacitorPlugin annotation once, in PluginHandle,
# and keeps it in a field for every permission check. R8 dropped that field's
# write and folded the reads to null, so every permission was "missing": the
# notification status always "default" and asking for it did nothing at all.
# Its core is small and works by reflection throughout: kept whole.
-keep class com.getcapacitor.** { *; }
-keep @interface com.getcapacitor.annotation.** { *; }
