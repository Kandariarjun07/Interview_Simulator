import { pipeline } from "@xenova/transformers";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { decode } from "wav-decoder";
import axios from "axios";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

let transcriber: any = null;

export async function initWhisper() {
  if (!transcriber) {
    console.log("Loading Whisper model (tiny.en)...");
    transcriber = await pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny.en"
    );
    console.log("Whisper loaded.");
  }
  return transcriber;
}

export async function convertToWav(
  inputPath: string,
  outDir = "./tmp"
): Promise<string> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Audio chunk missing: ${inputPath}`);
  }
  const stats = fs.statSync(inputPath);
  if (stats.size === 0) {
    throw new Error("Recording was empty — please try again.");
  }

  fs.mkdirSync(outDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const fileName = path.basename(inputPath, path.extname(inputPath));
    const wavPath = path.join(outDir, `${fileName}.wav`);

    ffmpeg(inputPath)
      .inputOptions(["-f", "webm"])
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("error", (err: any) => reject(err))
      .on("end", () => resolve(wavPath))
      .save(wavPath);
  });
}

export async function transcribeAudio(filePath: string) {
  await initWhisper();

  if (!fs.existsSync(filePath)) {
    throw new Error("Audio file not found: " + filePath);
  }

  const buffer = fs.readFileSync(filePath);
  const decoded = await decode(buffer);
  const [firstChannel] = decoded.channelData;
  if (!firstChannel || !firstChannel.length) {
    throw new Error("Decoded audio produced no samples.");
  }

  const floatArray = new Float32Array(firstChannel.length);
  floatArray.set(firstChannel);
  (floatArray as any).sampling_rate = decoded.sampleRate ?? 16000;

  const result = await transcriber(floatArray);
  return result.text;
}

export async function transcribeWithDeepgram(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new Error("DEEPGRAM_API_KEY not set");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error("Audio file not found: " + filePath);
  }
  const ext = path.extname(filePath).toLowerCase();
  const inferredMime =
    mimeType || (ext === ".wav" ? "audio/wav" : ext === ".mp3" ? "audio/mpeg" : "audio/webm");

  const audio = fs.readFileSync(filePath);
  const url = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en";
  const resp = await axios.post(url, audio, {
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": inferredMime
    },
    timeout: 120000
  });
  const data = resp.data as any;
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (!transcript) {
    throw new Error("Deepgram returned no transcript");
  }
  return transcript as string;
}
