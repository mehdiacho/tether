package tech.mehdiacho.tether.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import tech.mehdiacho.tether.data.PairingLink
import tech.mehdiacho.tether.data.looksLikePairingCode
import tech.mehdiacho.tether.data.normalizePairingCode
import tech.mehdiacho.tether.data.parsePairingPayload

/**
 * First run: point the app at a Tether server and claim a pairing code.
 *
 * Scanning is the whole screen's default because typing a server address and a
 * code into a phone is the single worst part of self-hosting anything. The QR
 * carries both, so the ordinary path is one tap and a camera. Manual entry is
 * still here — a server reached over a VPN with no second screen to hand is a
 * real situation — but it is folded away rather than presented as the norm.
 *
 * Nothing on this screen is a credential. The code it claims is single-use and
 * expires in minutes; what comes back is a token scoped to this device alone.
 */
@Composable
fun PairScreen(store: TetherStore, initialLink: PairingLink? = null, onLinkHandled: () -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var url by remember { mutableStateOf("https://") }
    var code by remember { mutableStateOf("") }
    var manual by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var scanError by remember { mutableStateOf<String?>(null) }

    // A link tapped outside the app — a message, a browser — arrives already
    // complete, so there is nothing to ask and nothing to confirm.
    LaunchedEffect(initialLink) {
        val link = initialLink ?: return@LaunchedEffect
        url = link.url
        code = link.code
        store.clearError()
        store.pair(link.url, link.code)
        onLinkHandled()
    }

    fun handlePayload(payload: String) {
        val link = parsePairingPayload(payload)
        when {
            link != null -> {
                url = link.url
                code = link.code
                scanError = null
                scope.launch { store.pair(link.url, link.code) }
            }

            // A code-only QR still saves the worse half of the typing.
            looksLikePairingCode(payload) -> {
                code = normalizePairingCode(payload)
                manual = true
                scanError = "That code is valid, but it does not say which server. Add the address."
            }

            else -> scanError = "That QR code is not a Tether pairing code."
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 28.dp, vertical = 48.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.Start,
    ) {
        Text(
            "Tether",
            fontSize = 40.sp,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Your agents' phone line. Pair this device with your server to start " +
                "receiving calls and questions.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 15.sp,
        )

        Spacer(Modifier.height(36.dp))

        Button(
            onClick = {
                scanError = null
                store.clearError()
                scope.launch {
                    scanning = true
                    val result = QrScanner.scan(context)
                    scanning = false
                    result
                        .onSuccess { handlePayload(it) }
                        .onFailure { error ->
                            when (error) {
                                is QrScanner.Cancelled -> Unit // backing out is not a failure
                                is QrScanner.ScannerUnavailable -> {
                                    manual = true
                                    scanError = "No QR scanner on this device — enter the details instead."
                                }

                                else -> scanError = error.message ?: "Could not start the scanner."
                            }
                        }
                }
            },
            enabled = !scanning && !store.loading,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
        ) {
            if (scanning || store.loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                Icon(Icons.Filled.QrCodeScanner, contentDescription = null)
                Spacer(Modifier.width(10.dp))
                Text("Scan QR code", fontSize = 16.sp)
            }
        }

        Spacer(Modifier.height(14.dp))
        Text(
            "On the server, run ‘npm run pair’ — or open the Tether web UI and " +
                "tap ‘Pair phone’. Either shows a QR code to point this at.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 13.sp,
        )

        scanError?.let {
            Spacer(Modifier.height(14.dp))
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }

        Spacer(Modifier.height(24.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            HorizontalDivider(Modifier.weight(1f))
            Text(
                "  or  ",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
            )
            HorizontalDivider(Modifier.weight(1f))
        }

        Spacer(Modifier.height(8.dp))

        TextButton(
            onClick = { manual = !manual },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (manual) "Hide manual setup" else "Enter details manually")
        }

        if (manual) {
            Spacer(Modifier.height(12.dp))

            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Server address") },
                placeholder = { Text("https://tether.example.com") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Next,
                ),
            )

            Spacer(Modifier.height(16.dp))

            OutlinedTextField(
                value = code,
                // Uppercased as you type: the codes are printed uppercase and the
                // server compares them that way, so a lowercase entry that fails is
                // a needless dead end.
                onValueChange = { code = it.uppercase() },
                label = { Text("Pairing code") },
                placeholder = { Text("XXXX-XXXX") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters,
                    imeAction = ImeAction.Done,
                ),
            )

            Spacer(Modifier.height(8.dp))
            Text(
                "Codes expire five minutes after they are issued.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
            )

            Spacer(Modifier.height(20.dp))

            OutlinedButton(
                onClick = {
                    store.clearError()
                    scanError = null
                    scope.launch { store.pair(url, normalizePairingCode(code)) }
                },
                enabled = !store.loading && url.length > 8 && code.length >= 8,
                colors = ButtonDefaults.outlinedButtonColors(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Pair this device")
            }
        }

        store.error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
        }
    }
}
