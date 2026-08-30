package tech.mehdiacho.tether.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Deliberately not dynamic colour.
 *
 * A call screen has to be recognisable in the half-second before you decide to
 * pick up, and letting it retint itself from the wallpaper works against that.
 * The green is the same one the ringing screen uses, so the app and the call
 * read as the same thing.
 */

private val Green = Color(0xFF30A46C)
private val GreenBright = Color(0xFF5EE7B0)
private val Red = Color(0xFFE5484D)

private val Dark = darkColorScheme(
    primary = GreenBright,
    onPrimary = Color(0xFF04231A),
    primaryContainer = Color(0xFF12281F),
    onPrimaryContainer = GreenBright,
    secondary = Color(0xFF8FA5B2),
    background = Color(0xFF05080B),
    onBackground = Color(0xFFE6EDF3),
    surface = Color(0xFF0D1218),
    onSurface = Color(0xFFE6EDF3),
    surfaceVariant = Color(0xFF1A222B),
    onSurfaceVariant = Color(0xFF9FB0BC),
    error = Red,
    outline = Color(0xFF2C3742),
)

private val Light = lightColorScheme(
    primary = Green,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD6F5E5),
    onPrimaryContainer = Color(0xFF04231A),
    secondary = Color(0xFF4A5C68),
    background = Color(0xFFF7F9FB),
    onBackground = Color(0xFF0D1218),
    surface = Color.White,
    onSurface = Color(0xFF0D1218),
    surfaceVariant = Color(0xFFEAEFF3),
    onSurfaceVariant = Color(0xFF4A5C68),
    error = Red,
    outline = Color(0xFFD3DCE3),
)

@Composable
fun TetherTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) Dark else Light,
        content = content,
    )
}
