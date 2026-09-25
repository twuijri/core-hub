# kotlinx.serialization: keep the generated serializers of the contract's models.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class hub.core.client.model.** { *** Companion; }
-keepclasseswithmembers class hub.core.client.model.** { kotlinx.serialization.KSerializer serializer(...); }
-keep class hub.core.client.model.**$$serializer { *; }
# Socket.IO / Engine.IO reflectively look up their transports.
-keep class io.socket.** { *; }
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
