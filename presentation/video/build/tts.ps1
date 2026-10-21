# Synthesise every segment in segments.json with the offline Windows voice.
# Writes build/tts/<id>.wav (16 kHz mono, the voice's native rate) and build/tts/words.json
# with per-word start times. SAPI's word positions are accurate at 16 kHz output;
# its bookmark positions are not, so the pipeline times everything from words.
# Usage: powershell -File tts.ps1 [-Voice "Microsoft Zira Desktop"] [-Rate 2]
param(
    [string]$Voice = "Microsoft Zira Desktop",
    [int]$Rate = 2
)
$ErrorActionPreference = "Stop"
$build = $PSScriptRoot
$outDir = Join-Path $build "tts"
New-Item -ItemType Directory -Force $outDir | Out-Null

Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Speech.Synthesis;
using System.Speech.AudioFormat;
using System.Threading;

public static class SegmentTts {
    public static string Run(string ssml, string wavPath, string voice, int rate) {
        var words = new List<string>();
        var done = new ManualResetEvent(false);
        var inv = CultureInfo.InvariantCulture;
        using (var s = new SpeechSynthesizer()) {
            s.SelectVoice(voice);
            s.Rate = rate;
            s.SetOutputToWaveFile(wavPath, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            s.SpeakProgress += (o, e) => {
                string w = e.Text.Replace("\\", "\\\\").Replace("\"", "\\\"");
                string t = e.AudioPosition.TotalSeconds.ToString("F4", inv);
                lock (words) words.Add("{\"text\":\"" + w + "\",\"t\":" + t + "}");
            };
            s.SpeakCompleted += (o, e) => done.Set();
            s.SpeakSsmlAsync(ssml);
            done.WaitOne();
            Thread.Sleep(200);
            s.SetOutputToNull();
        }
        lock (words) return "[" + String.Join(",", words) + "]";
    }
}
"@

$segments = Get-Content -Raw -Encoding UTF8 (Join-Path $build "segments.json") | ConvertFrom-Json
$entries = @()
foreach ($seg in $segments) {
    $wav = Join-Path $outDir ($seg.id + ".wav")
    $words = [SegmentTts]::Run($seg.ssml, $wav, $Voice, $Rate)
    $entries += "`"$($seg.id)`": $words"
}
$json = "{`n" + ($entries -join ",`n") + "`n}"
[System.IO.File]::WriteAllText((Join-Path $outDir "words.json"), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Output "synthesised $($segments.Count) segments"
