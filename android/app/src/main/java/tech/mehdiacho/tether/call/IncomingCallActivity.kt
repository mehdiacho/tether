package tech.mehdiacho.tether.call

import android.app.KeyguardManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import tech.mehdiacho.tether.data.IncomingCall
import tech.mehdiacho.tether.ui.theme.TetherTheme

/**
 * The ringing screen.
 *
 * Shows over the lock screen and turns the display on — see the manifest flags.
 * It holds no call state of its own: everything comes from [CallController], so
 * being destroyed and recreated (rotation, or the system reclaiming memory
 * mid-ring) rejoins the call in progress rather than losing it.
 */
class IncomingCallActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockScreen()

        // The push payload is a fallback for the very first frame: the service
        // publishes state within milliseconds, but starting from Idle would
        // flash an empty screen before it arrives.
        val fromIntent = intent.getBundleExtra(CallService.EXTRA_CALL)?.toIncomingCall()

        setContent {
            TetherTheme {
                val state by CallController.state.collectAsStateWithLifecycle()
                var speakerOn by remember { mutableStateOf(false) }

                val call = state.call ?: fromIntent
                if (call == null) {
                    finish()
                    return@TetherTheme
                }

                CallScreen(
                    call = call,
                    state = state,
                    speakerOn = speakerOn,
                    onAnswer = { CallController.answer(this) },
                    onDecline = { CallController.decline(this) },
                    onHangUp = { CallController.hangUp(this) },
                    onToggleSpeaker = {
                        speakerOn = !speakerOn
                        CallController.setSpeaker(this, speakerOn)
                    },
                    onDismiss = { finish() },
                )
            }
        }
    }

    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            )
        }
    }

    /**
     * Back must not silently dismiss a ringing call — that would look like the
     * call vanished while the phone kept ringing in the background. Declining
     * is the honest interpretation of "get this off my screen".
     */
    @Deprecated("Handled explicitly so back declines rather than orphaning the call")
    override fun onBackPressed() {
        when (CallController.state.value) {
            is CallUiState.Ringing -> CallController.decline(this)
            is CallUiState.Idle, is CallUiState.Ended -> finish()
            else -> Unit // Mid-call: ignore, the way a dialler does.
        }
    }
}

@Composable
private fun CallScreen(
    call: IncomingCall,
    state: CallUiState,
    speakerOn: Boolean,
    onAnswer: () -> Unit,
    onDecline: () -> Unit,
    onHangUp: () -> Unit,
    onToggleSpeaker: () -> Unit,
    onDismiss: () -> Unit,
) {
    val ringing = state is CallUiState.Ringing
    val ended = state is CallUiState.Ended
    val spoken = when (state) {
        is CallUiState.Active -> state.spoken
        is CallUiState.Listening -> state.spoken
        else -> ""
    }
    val draft = (state as? CallUiState.Listening)?.draft.orEmpty()

    Box(
        Modifier
            .fillMaxSize()
            .background(
                Brush.radialGradient(
                    colors = listOf(Color(0xFF10231C), Color(0xFF05080B)),
                    center = Offset(0.5f, 0.25f),
                    radius = 1600f,
                ),
            ),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(horizontal = 28.dp, vertical = 56.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))

            Text(
                text = when (state) {
                    is CallUiState.Ringing -> "Incoming call"
                    is CallUiState.Connecting -> "Connecting…"
                    is CallUiState.Active -> "Connected"
                    is CallUiState.Listening ->
                        if (state.thinking) "Thinking…" else "Listening…"
                    is CallUiState.Ended -> state.reason
                    is CallUiState.Idle -> ""
                },
                color = Color(0xFF7C8B96),
                fontSize = 15.sp,
                letterSpacing = 1.5.sp,
            )

            Spacer(Modifier.height(12.dp))

            Text(
                text = call.agent,
                color = Color.White,
                fontSize = 34.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(6.dp))

            Text(
                text = call.title,
                color = Color(0xFF9FB0BC),
                fontSize = 16.sp,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(48.dp))

            PulsingAvatar(active = ringing, speaking = state is CallUiState.Active)

            Spacer(Modifier.height(40.dp))

            // Once connected, show what is actually being said. A voice call you
            // half-heard is much more useful with the text in front of you. It
            // stays up through Listening: the last thing said is exactly what
            // you want in front of you while deciding how to answer it.
            AnimatedVisibility(
                visible = spoken.isNotBlank(),
                enter = fadeIn(tween(400)),
            ) {
                Text(
                    text = spoken.stripMarkers(),
                    color = Color(0xFFD6E2EA),
                    fontSize = 17.sp,
                    lineHeight = 25.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // The caller's own words, as the phone hears them. Not decoration:
            // it is the only way to tell "it is not picking me up" apart from
            // "it heard me and is thinking", which otherwise look identical.
            AnimatedVisibility(
                visible = draft.isNotBlank(),
                enter = fadeIn(tween(250)),
            ) {
                Text(
                    text = draft,
                    color = Color(0xFF6FD3A6),
                    fontSize = 16.sp,
                    lineHeight = 23.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 20.dp),
                )
            }

            Spacer(Modifier.weight(1f))

            when {
                ended -> RoundButton(
                    background = Color(0xFF243039),
                    onClick = onDismiss,
                    content = { Icon(Icons.Filled.CallEnd, "Dismiss", tint = Color.White) },
                )

                ringing -> Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    RoundButton(
                        background = Color(0xFFE5484D),
                        onClick = onDecline,
                        content = { Icon(Icons.Filled.CallEnd, "Decline", tint = Color.White) },
                    )
                    RoundButton(
                        background = Color(0xFF30A46C),
                        onClick = onAnswer,
                        pulsing = true,
                        content = { Icon(Icons.Filled.Call, "Answer", tint = Color.White) },
                    )
                }

                else -> Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RoundButton(
                        size = 60,
                        background = if (speakerOn) Color(0xFF2C5C4A) else Color(0xFF243039),
                        onClick = onToggleSpeaker,
                        content = { Icon(Icons.AutoMirrored.Filled.VolumeUp, "Speaker", tint = Color.White) },
                    )
                    RoundButton(
                        background = Color(0xFFE5484D),
                        onClick = onHangUp,
                        content = { Icon(Icons.Filled.CallEnd, "Hang up", tint = Color.White) },
                    )
                    Spacer(Modifier.width(60.dp))
                }
            }

            Spacer(Modifier.height(16.dp))
        }
    }
}

/**
 * The ringing avatar: concentric rings expanding outward while it rings, and a
 * gentler breathing pulse once connected.
 *
 * Rendered as scaled circles rather than a Canvas so the whole thing stays
 * declarative and there is no draw-loop to leak.
 */
@Composable
private fun PulsingAvatar(active: Boolean, speaking: Boolean) {
    val transition = rememberInfiniteTransition(label = "ring")

    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(220.dp)) {
        if (active) {
            repeat(3) { index ->
                val progress by transition.animateFloat(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(2200, easing = LinearEasing),
                        // Stagger the rings so they read as an outward pulse
                        // rather than three circles blinking in unison.
                        initialStartOffset = androidx.compose.animation.core.StartOffset(index * 730),
                    ),
                    label = "ripple$index",
                )
                Box(
                    Modifier
                        .size(120.dp)
                        .scale(0.9f + progress * 0.85f)
                        .alpha((1f - progress) * 0.35f)
                        .background(Color(0xFF5EE7B0), CircleShape),
                )
            }
        }

        val breathe by transition.animateFloat(
            initialValue = 1f,
            targetValue = if (speaking) 1.06f else 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(900, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "breathe",
        )

        Box(
            Modifier
                .size(120.dp)
                .scale(breathe)
                .background(Color(0xFF12281F), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.Call,
                contentDescription = null,
                tint = Color(0xFF5EE7B0),
                modifier = Modifier.size(46.dp),
            )
        }
    }
}

@Composable
private fun RoundButton(
    background: Color,
    onClick: () -> Unit,
    size: Int = 74,
    pulsing: Boolean = false,
    content: @Composable () -> Unit,
) {
    val transition = rememberInfiniteTransition(label = "btn")
    val scale by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (pulsing) 1.08f else 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(800, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "btnScale",
    )

    Box(
        Modifier
            .size(size.dp)
            .scale(scale)
            .background(background, CircleShape)
            .clickableNoRipple(onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

/**
 * A tap target with no ripple.
 *
 * The default ripple is a rectangle clipped to the layout bounds, which on a
 * circle drawn with a background modifier flashes as a square. Circle-clipping
 * the whole button just to get the ripple right is more machinery than the
 * effect is worth on a screen you look at for six seconds.
 */
@Composable
private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier {
    val interaction = remember { MutableInteractionSource() }
    return clickable(interactionSource = interaction, indication = null, onClick = onClick)
}

/**
 * Strip the `[bracket]` delivery markers before showing text on screen.
 *
 * They are instructions to the speech model, not part of the message — showing
 * "[warmly] Morning" to the person being called is a leak of the plumbing.
 */
private fun String.stripMarkers(): String =
    replace(Regex("""\[[^\]]*]"""), "").replace(Regex("""\s+"""), " ").trim()
