// The version lives in package.json at the repo root and nowhere else. The
// server and the app ship as one product, and two version numbers that drift
// apart become a support question every single time.
val appVersionName: String = run {
    val pkg = rootProject.file("../package.json")
    pkg.readText()
        .substringAfter("\"version\"", "")
        .substringAfter(':')
        .substringAfter('"')
        .substringBefore('"')
        .trim()
        .ifEmpty { error("no version field in ${pkg.path}") }
}

// Play requires a monotonically increasing integer. Packing the semver into
// fixed decimal fields keeps it monotonic without needing a build counter,
// which would tie the number to CI history rather than to the release.
val appVersionCode: Int = run {
    val parts = appVersionName.split(".", limit = 3).map { it.takeWhile(Char::isDigit).toInt() }
    parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2]
}

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.google.services)
}

android {
    namespace = "tech.mehdiacho.tether"
    compileSdk = 36

    defaultConfig {
        applicationId = "tech.mehdiacho.tether"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        create("release") {
            // CI injects these. Locally they are absent, and a local release
            // build simply comes out unsigned rather than failing — only CI is
            // meant to cut installable builds, so the key has one home.
            val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (ksPath != null && file(ksPath).exists()) {
                storeFile = file(ksPath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
                signingConfig = signingConfigs.getByName("release")
            }

            // Keep the first Play upload readable in a crash report. Shrinking
            // is worth turning on once the surface stops changing weekly.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    debugImplementation(libs.androidx.ui.tooling)

    // REST and WebSocket in one dependency. JSON is handled with org.json from
    // the platform rather than a serialization library — the payloads are small
    // and flat, and it keeps the compiler-plugin count at one.
    implementation(libs.okhttp)

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    // Google's code scanner: a full scanning UI provided by Play Services, in a
    // separate process. That is why the app declares no CAMERA permission —
    // pairing should not cost the user a camera grant they then have to trust.
    implementation(libs.play.services.code.scanner)
}
