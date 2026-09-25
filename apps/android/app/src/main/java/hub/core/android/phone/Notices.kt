package hub.core.android.phone

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import hub.core.android.MainActivity
import hub.core.android.R
import hub.core.android.generated.Product
import hub.core.android.graph
import hub.core.client.model.Notice
import hub.core.client.model.ResourceRef
import java.util.concurrent.TimeUnit

/**
 * Which notices to show as phone notifications when push is not active (PushManager): what the
 * realtime socket announces while the app runs and what a background check finds while it does
 * not; each notice once, only unread ones, newest last.
 */
object NoticeTracker {
    fun fresh(notices: List<Notice>, seenAt: Long): List<Notice> =
        notices.filter { it.readAt == null && it.createdAt.toInstant().toEpochMilli() > seenAt }
            .sortedBy { it.createdAt }

    fun seenAfter(notices: List<Notice>, seenAt: Long): Long =
        (notices.map { it.createdAt.toInstant().toEpochMilli() } + seenAt).max()

    /** The in-app path a notice opens (`corehub://open/<path>`, the paths of `surfaceRoutes.android`). */
    fun path(notice: Notice): String = path(notice.resource?.kind?.value, notice.resource?.id, notice.profile)

    /**
     * The same from the parts a push carries (`resource_kind`, `resource_id`, `profile`): a
     * `ResourceRef.kind` value, its id and the notice's profile, any of them absent.
     */
    fun path(kind: String?, id: String?, profile: String?): String = when (kind) {
        ResourceRef.Kind.SESSION.value ->
            if (id.isNullOrBlank()) "/settings/notifications"
            else "/chat/${enc(id)}" + (profile?.takeIf { it.isNotBlank() }?.let { "?profile=${enc(it)}" } ?: "")
        ResourceRef.Kind.TASK.value, ResourceRef.Kind.PROJECT.value -> "/tasks"
        ResourceRef.Kind.SCHEDULE.value, ResourceRef.Kind.SCHEDULE_RUN.value, ResourceRef.Kind.WORKFLOW_RUN.value -> "/schedules"
        else -> "/settings/notifications"
    }

    private fun enc(part: String) = java.net.URLEncoder.encode(part, "UTF-8")
}

/** Posts notices as Android notifications on one channel. */
class Notifier(private val context: Context) {
    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.notices_channel), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    fun allowed(): Boolean =
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun post(notice: Notice) = post(notice.id, notice.title, notice.body, NoticeTracker.path(notice))

    /**
     * One notification per notice: tagged with the notice's id and numbered 0, the slot FCM itself
     * uses for a push the system shows (`android.notification.tag` = the notice id), so the same
     * notice seen twice — by push and by the socket — replaces itself instead of appearing twice.
     */
    fun post(noticeId: String, title: String, body: String?, path: String) {
        if (!allowed()) return
        ensureChannel()
        val open = Intent(Intent.ACTION_VIEW, Uri.parse("${Product.SCHEME}://open$path"), context, MainActivity::class.java)
        val pending = PendingIntent.getActivity(context, noticeId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notice)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(noticeId, 0, notification)
        } catch (_: SecurityException) {
            // The permission was withdrawn between the check and the post.
        }
    }

    companion object {
        const val CHANNEL = "notices"
    }
}

/**
 * The background check: every 15 minutes, with a network, while signed in, switched on, and push
 * is not carrying the notices already (AppGraph).
 */
class NoticeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = applicationContext.graph
        val session = graph.store.current ?: return Result.success()
        if (!graph.device.choices.value.backgroundNotices || graph.push.active) return Result.success()
        return try {
            val notices = graph.apis(session).notify.notifyListNotices(unread = true, limit = 20).items
            val seen = graph.device.noticesSeenAt
            val notifier = Notifier(applicationContext)
            NoticeTracker.fresh(notices, seen).forEach(notifier::post)
            graph.device.noticesSeenAt = NoticeTracker.seenAfter(notices, seen)
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    companion object {
        private const val NAME = "corehub.notices"

        fun schedule(context: Context, on: Boolean) {
            val work = WorkManager.getInstance(context)
            if (!on) {
                work.cancelUniqueWork(NAME)
                return
            }
            val request = PeriodicWorkRequestBuilder<NoticeWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            work.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
