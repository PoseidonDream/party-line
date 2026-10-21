# Phone apps and code signing

Everything here is optional. The apps work without it. Signing removes the "unknown developer" warnings, and for Android it lets phones install updates over the old version.

All of it goes in GitHub, in the repository's **Settings → Secrets and variables → Actions**. **Secrets** are hidden values like passwords. **Variables** are plain settings. Every build workflow reads them from there.

## Android app

The Android app is the Party Line website inside an app, plus one thing the website can't do: **voice keeps running when the phone locks or you switch apps**. While you're in voice, an "In voice" notification shows, the way Discord does it.

### Build it
1. Set the variable `PARTY_LINE_SERVER` to your server's address (the same one the desktop app uses).
2. Go to **Actions → Android app → Run workflow**. After about 5 minutes, the finished run has a **party-line-android** download containing the `.apk`.
3. To publish it on the Releases page for friends instead, push a tag such as `android-v1.0.0`.

Friends open the `.apk` on their phone and allow "install unknown apps" for their browser or file manager when Android asks.

### Sign it (free, do it once)
Without a signing key, each build is signed with a throwaway key, so to update the app people have to uninstall the old one first. Make a permanent key once:

```
keytool -genkeypair -v -keystore party-line.jks -alias partyline -keyalg RSA -keysize 2048 -validity 10000
```

(`keytool` comes with Java. It asks for a password; remember it.) Then add these **secrets**:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the key file as text: `base64 -w0 party-line.jks` (Mac: `base64 -i party-line.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | the password you picked |
| `ANDROID_KEY_ALIAS` | `partyline` |
| `ANDROID_KEY_PASSWORD` | the same password |

Keep `party-line.jks` somewhere safe. If you lose it, phones can't update to new versions, and everyone has to reinstall.

### Google Play (optional)
To put Party Line on the Play Store, you need a Google Play developer account ($25, one time). Upload a signed build made with the key above. Most friend groups just share the `.apk` instead.

## iPhone app

Apple only allows iPhone apps that are signed with a paid **Apple Developer** account ($99 a year), and they have to be built on a Mac. When you have both:

```
cd app/mobile
npm install @capacitor/ios
npx cap add ios
npx cap open ios
```

In Xcode, choose your team under Signing, then use Product → Archive to send it to TestFlight, Apple's app for sharing test builds. Friends install it from there. The background-voice part needs the "Audio, AirPlay and Picture in Picture" background mode turned on under Signing & Capabilities.

Until then, iPhone users can use the website: open it in Safari → Share → **Add to Home Screen**.

## Windows: remove "Windows protected your PC"

Use **Azure Trusted Signing** (about $10 a month, Microsoft's cheapest signing option):
1. In the Azure portal, create a Trusted Signing account and a certificate profile ("Public Trust"). Microsoft verifies your identity first, which can take a few days.
2. Create an app registration and give it the "Trusted Signing Certificate Profile Signer" role.
3. Add these **secrets**: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
4. Add these **variables**:

| Variable | Example |
|---|---|
| `AZURE_SIGNING_ENDPOINT` | `https://weu.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | your Trusted Signing account name |
| `AZURE_CERT_PROFILE` | your certificate profile name |
| `AZURE_PUBLISHER_NAME` | the name on your certificate |

The next desktop build signs the Windows installer automatically.

## Mac: remove "can't be opened because Apple cannot check it"

With an Apple Developer account ($99 a year):
1. In Xcode or on developer.apple.com, make a **Developer ID Application** certificate and export it as a `.p12` file with a password.
2. Make an app-specific password at appleid.apple.com.
3. Add these **secrets**:

| Secret | Value |
|---|---|
| `MAC_CERT_P12_BASE64` | `base64 -i certificate.p12` |
| `MAC_CERT_PASSWORD` | the `.p12` password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your 10-character team ID |

The next desktop build is signed and notarized by Apple automatically.
