package tech.mehdiacho.tether.ui

import android.content.Context
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Scanning a QR code, borrowed rather than built.
 *
 * Google's code scanner runs the camera preview inside Play Services, in
 * another process, and hands back only the decoded string. That means this app
 * declares no CAMERA permission and shows no camera UI of its own — pairing
 * costs the user nothing but a tap, and the app never holds a camera grant it
 * would otherwise carry forever for a one-time setup step.
 *
 * The trade is a dependency on Play Services, which this app already has for
 * push. A device without it cannot ring in the first place, so there is no
 * scenario where scanning is the only thing missing — but the manual entry path
 * stays available regardless, and [ScannerUnavailable] is what routes the user
 * to it.
 */
object QrScanner {

    /** The user backed out. Not an error, and not worth a message. */
    class Cancelled : Exception("Scan cancelled")

    /** No usable scanner on this device — fall back to typing. */
    class ScannerUnavailable(cause: Throwable?) :
        Exception("This device cannot scan QR codes.", cause)

    suspend fun scan(context: Context): Result<String> = suspendCancellableCoroutine { cont ->
        val scanner: GmsBarcodeScanner = GmsBarcodeScanning.getClient(
            context,
            GmsBarcodeScannerOptions.Builder()
                // Only QR. Narrowing the formats makes the scanner noticeably
                // quicker to lock on, and nothing else here is a pairing code.
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build(),
        )

        scanner.startScan()
            .addOnSuccessListener { barcode ->
                val value = barcode.rawValue
                cont.resume(
                    if (value.isNullOrBlank()) {
                        Result.failure(Exception("That code was empty."))
                    } else {
                        Result.success(value)
                    },
                )
            }
            .addOnCanceledListener { cont.resume(Result.failure(Cancelled())) }
            .addOnFailureListener { error ->
                cont.resume(Result.failure(translate(error)))
            }
    }

    /**
     * Play Services reports both "user pressed back" and "this device has no
     * scanner" as failures. They need very different handling, so they are
     * separated here rather than at every call site.
     */
    private fun translate(error: Exception): Throwable = when {
        error !is MlKitException -> error
        error.errorCode == MlKitException.CODE_SCANNER_CANCELLED -> Cancelled()
        error.errorCode == MlKitException.CODE_SCANNER_UNAVAILABLE ||
            error.errorCode == MlKitException.UNAVAILABLE -> ScannerUnavailable(error)
        else -> error
    }
}
