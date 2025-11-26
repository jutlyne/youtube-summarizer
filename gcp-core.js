import 'dotenv/config';
import https from 'https';
import { pipeline } from 'stream/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import yt from '@vreden/youtube_scraper';
import { GoogleGenAI } from '@google/genai';
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { Storage } from '@google-cloud/storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KEY_FILE_PATH = join(__dirname, 'key.json');

const CONFIG = {
  GCS_BUCKET_NAME: process.env.GCS_BUCKET_NAME || 'youtube-audio-bucket-kyvc',
  MODEL_NAME: 'gemini-2.5-pro',
  LANGUAGE_CODE: 'vi-VN',
  TTS_VOICE: 'vi-VN-Neural2-A',
  AUDIO_ENCODING: 'MP3',
  SAMPLE_RATE: 44100
};

// --- PROMPTS ---
const SYSTEM_PROMPT = `
  You are a professional video-summary assistant.

  Your task:
  Summarize the following content EXACTLY as specified below. 
  Do NOT include any greeting, preface, introduction, filler phrase, or explanation. 
  Output ONLY the summary content.

  Requirements:
  1. Use Vietnamese.
  2. Be extremely detailed, clear and concise, focusing on events, observations and key takeaways.
  3. MUST segment the summary into major sections (e.g., Introduction, Observations, Experience, Price, Conclusion).
  4. MUST include timestamps ([mm:ss]) after each key point.
  5. Do NOT add timestamps that do not exist.
  6. Do NOT add any text before or after the summary.

  Structure:
  - Summary Title
  - Section 1: Introduction / Context (with timestamps)
  - Section 2: Street / Scene Observations (with timestamps)
  - Section 3: Specific Experiences (with timestamps)
  - Section 4: Price Disclosures & Personal Opinions (with timestamps)
  - Section 5: Closing (with timestamps)
`;

const speechClient = new SpeechClient({ keyFile: KEY_FILE_PATH });
const ttsClient = new TextToSpeechClient({ keyFilename: KEY_FILE_PATH });
const storageClient = new Storage({ keyFilename: KEY_FILE_PATH });
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GEN_AI_API_KEY });

/**
 * Format seconds into [mm:ss] string
 */
function formatTimestamp(secondsObj) {
  const totalSeconds = parseInt(secondsObj || 0, 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
}

/**
 * Wrapper function to call Gemini to avoid duplication
 */
async function callGemini(contents) {
  try {
    const response = await ai.models.generateContent({
      model: CONFIG.MODEL_NAME,
      contents: contents,
      config: {
        temperature: 0.3
      }
    });
    return response.text;
  } catch (error) {
    console.error(`❌ Gemini API Error (${CONFIG.MODEL_NAME}):`, error.message);
    throw error;
  }
}

/**
 * Stream audio from YouTube URL directly to GCS using Pipeline
 */
export async function streamAudioToGCS(youtubeUrl, gcsFileName) {
  console.log('-> 🎵 Searching for audio link...');

  const ytmp3Result = await yt.ytmp3(youtubeUrl, 128);
  const downloadUrl = ytmp3Result?.download?.url;

  if (!downloadUrl) {
    throw new Error('Unable to find a valid audio download link from YouTube.');
  }

  console.log(`-> 🔗 Streaming to GCS: gs://${CONFIG.GCS_BUCKET_NAME}/${gcsFileName}`);

  const bucket = storageClient.bucket(CONFIG.GCS_BUCKET_NAME);
  const file = bucket.file(gcsFileName);
  const gcsWriteStream = file.createWriteStream({
    metadata: { contentType: 'audio/mp3' },
  });

  return new Promise((resolve, reject) => {
    const req = https.get(downloadUrl, async (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      try {
        await pipeline(response, gcsWriteStream);
        const gcsUri = `gs://${CONFIG.GCS_BUCKET_NAME}/${gcsFileName}`;
        console.log(`-> ✅ Uploaded to GCS: ${gcsUri}`);
        resolve(gcsUri);
      } catch (err) {
        reject(new Error(`Stream pipeline error: ${err.message}`));
      }
    });

    req.on('error', (err) => reject(new Error(`Request error: ${err.message}`)));
  });
}

/**
 * Transcribe audio using Google Speech-to-Text
 */
export async function transcribeAudio(gcsUri) {
  console.log('-> 🗣️ Requesting Transcription (LongRunningRecognize)...');

  const request = {
    audio: { uri: gcsUri },
    config: {
      encoding: CONFIG.AUDIO_ENCODING,
      languageCode: CONFIG.LANGUAGE_CODE,
      enableAutomaticPunctuation: true,
      enableSpeakerDiarization: true,
      sampleRateHertz: CONFIG.SAMPLE_RATE,
      enableWordTimeOffsets: true,
    },
  };

  try {
    const [operation] = await speechClient.longRunningRecognize(request);
    console.log('-> ⏳ Waiting for transcription...');
    
    const [response] = await operation.promise();
    const lines = [];

    response.results.forEach((result) => {
      const alternative = result.alternatives[0];
      if (alternative.words && alternative.words.length > 0) {
        const sentence = alternative.words.map(word => {
          return `${formatTimestamp(word.startTime.seconds)} ${word.word}`;
        }).join(' ');
        lines.push(sentence);
      } else {
        lines.push(alternative.transcript);
      }
    });

    console.log('-> ✅ Transcription completed.');
    return lines.join('\n');
  } catch (error) {
    console.error('❌ Speech-to-Text Error:', error.message);
    throw new Error('Failed to transcribe audio.');
  }
}

/**
 * Summarize Transcribed Text using Gemini
 */
export async function summarizeTextWithGemini(text) {
  console.log('-> 🧠 Summarizing Text with Gemini...');

  const prompt = `${SYSTEM_PROMPT}\n\nHere is the transcribed text:\n---\n${text}\n---`;
  
  const contents = [
    { role: 'user', parts: [{ text: prompt }] }
  ];

  const result = await callGemini(contents);
  console.log('-> ✅ Text Summary generated.');
  return result;
}

/**
 * Summarize Video directly (using File URI)
 */
export async function summarizeVideoWithGemini(uri) {
  console.log('-> 🎥 Summarizing Video with Gemini...');
  
  const contents = [
    {
      role: 'user',
      parts: [
        { text: SYSTEM_PROMPT },
        { 
          fileData: { 
            mimeType: 'video/mp4', 
            fileUri: uri 
          } 
        }
      ]
    }
  ];

  const result = await callGemini(contents);
  console.log('-> ✅ Video Summary generated.');
  return result;
}

/**
 * Delete GCS File
 */
export async function deleteGCSFile(gcsFileName) {
  if (!gcsFileName) return;
  try {
    await storageClient.bucket(CONFIG.GCS_BUCKET_NAME).file(gcsFileName).delete();
    console.log(`-> 🗑️ Deleted GCS file: ${gcsFileName}`);
  } catch (e) {
    console.warn(`⚠️ Warning: Could not delete ${gcsFileName}: ${e.message}`);
  }
}

/**
 * Generate Speech Audio (TTS)
 */
export async function generateSpeechAudio(text) {
  console.log('-> 🎤 Generating Speech (TTS)...');

  const request = {
    input: { text },
    voice: { languageCode: CONFIG.LANGUAGE_CODE, name: CONFIG.TTS_VOICE },
    audioConfig: { audioEncoding: CONFIG.AUDIO_ENCODING, speakingRate: 1.25 },
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);
    console.log('-> ✅ Audio generated.');
    return response.audioContent;
  } catch (error) {
    console.error('❌ TTS Error:', error.message);
    throw new Error('Failed to generate speech.');
  }
}