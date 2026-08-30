package tech.mehdiacho.tether.ui

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * Replaying a call recording after the fact.
 *
 * Deliberately not the call audio path. A call routes over the headset profile
 * because it is a conversation and needs the microphone; a recording is just
 * playback, so it goes out as ordinary media — which means it reaches Bluetooth
 * earbuds in full quality rather than through the narrow voice channel.
 *
 * One player for the whole list. Two recordings talking over each other is
 * never what anyone wanted, so starting one stops the other.
 */
class RecordingPlayer {

    /** The recording currently playing, by call id, or null. */
    var playingId by mutableStateOf<String?>(null)
        private set

    /** True between the tap and the first sound — network fetch, mostly. */
    var loadingId by mutableStateOf<String?>(null)
        private set

    private var player: MediaPlayer? = null

    fun toggle(id: String, url: String) {
        if (playingId == id || loadingId == id) stop() else start(id, url)
    }

    private fun start(id: String, url: String) {
        stop()
        loadingId = id
        player = runCatching {
            MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                setDataSource(url)
                setOnPreparedListener {
                    loadingId = null
                    playingId = id
                    it.start()
                }
                setOnCompletionListener { stop() }
                setOnErrorListener { _, what, extra ->
                    Log.w(TAG, "replay failed $what/$extra")
                    stop()
                    true
                }
                prepareAsync()
            }
        }.onFailure {
            Log.w(TAG, "could not open recording: ${it.message}")
            loadingId = null
        }.getOrNull()
    }

    fun stop() {
        player?.runCatching {
            if (isPlaying) stop()
            release()
        }
        player = null
        playingId = null
        loadingId = null
    }

    private companion object {
        const val TAG = "TetherReplay"
    }
}

/** A player scoped to the screen, released when it leaves. */
@Composable
fun rememberRecordingPlayer(): RecordingPlayer {
    val player = remember { RecordingPlayer() }
    DisposableEffect(Unit) { onDispose { player.stop() } }
    return player
}
