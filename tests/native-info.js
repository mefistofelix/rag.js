import * as path from "node:path";

const script = String.raw`
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[pscustomobject]@{
  availableLanguages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  profileLanguage = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages().RecognizerLanguage.LanguageTag
  os = [Environment]::OSVersion.VersionString
} | ConvertTo-Json
`;
const process = await new Deno.Command("powershell.exe", {
  args: ["-NoProfile", "-Command", script],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!process.success) throw new Error(new TextDecoder().decode(process.stderr));
const info = JSON.parse(
  new TextDecoder().decode(process.stdout).replace(/^\uFEFF/, ""),
);
await Deno.writeTextFile(
  path.resolve("build/results/windows-native-info.json"),
  JSON.stringify(info, null, 2),
);
console.log(JSON.stringify(info));
