
# SostAbile: R8 attivo solo per ridurre l'app e dare a Play il file di deoffuscamento.
# Si tengono interi il codice dell'app, Capacitor e i plugin (chiamati per nome dal JavaScript).
-keep class it.disabilityparking.app.** { *; }
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }
-keepclassmembers class * { @com.getcapacitor.PluginMethod public <methods>; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,SourceFile,LineNumberTable
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }
-dontwarn com.getcapacitor.**
-keep class com.equimaps.** { *; }
