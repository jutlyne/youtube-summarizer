import 'dotenv/config';
import https from 'https';
import yt from '@vreden/youtube_scraper';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { Storage } from '@google-cloud/storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KEY_FILE_PATH = join(__dirname, 'key.json');

/**
 * Google Cloud Storage bucket name used for temporary uploads.
 */
export const GCS_BUCKET_NAME = 'youtube-audio-bucket-kyvc';

/**
 * Initialize Google clients with the local service account key.
 * - SpeechClient: for long-running speech recognition
 * - TextToSpeechClient: for TTS synthesis
 * - Storage: for uploading/downloading temporary media files
 * - GoogleGenAI: for calling Gemini / GenAI models
 *
 * NOTE: these clients use the KEY_FILE_PATH for credentials.
 */
const speechClient = new SpeechClient({
  keyFile: KEY_FILE_PATH,
});
const ttsClient = new TextToSpeechClient({
  keyFilename: KEY_FILE_PATH,
});
const storageClient = new Storage({
  keyFilename: KEY_FILE_PATH,
});
const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GEN_AI_API_KEY,
});

const basePrompt = `
  You are a professional video-summary assistant.

  Your task:
  Summarize the following transcribed text EXACTLY as specified below. 
  Do NOT include any greeting, preface, introduction, filler phrase, or explanation. 
  Do NOT write phrases like “Chắc chắn rồi”, “Dưới đây là”, “Here is”, “Sure”, 
  “Tôi xin tóm tắt”, or anything similar. 
  Output ONLY the summary content.

  Requirements:
  1. Use Vietnamese.
  2. Be extremely detailed, clear and concise, focusing on events, observations and key takeaways.
  3. MUST segment the summary into major sections and subsections based on topics 
    (e.g., Introduction, Observations, Experience, Price Disclosure, Conclusion...).
  4. MUST include timestamps ([mm:ss] or [mm:ss–mm:ss]) after each key point or logical group of points.
  5. Do NOT add timestamps that do not exist or cannot be inferred from the transcript.
  6. Do NOT add any text before or after the summary.

  Required summary structure:
  - Summary Title (e.g., "Tóm tắt nội dung video")
  - Section 1: Introduction / Context (with timestamps)
  - Section 2: Street / Scene Observations (with timestamps)
  - Section 3: Specific Experiences (e.g., venue, interactions) (with timestamps)
  - Section 4: Price Disclosures & Personal Opinions (with timestamps)
  - Section 5: Closing / Final Observations (with timestamps)
`;

/**
 * Stream audio (MP3) from a YouTube URL directly into a GCS object without
 * saving a local file. Uses the @vreden/youtube_scraper to obtain a direct
 * download link and pipes the HTTPS response into a GCS write stream.
 *
 * @param {string} youtubeUrl - The YouTube video URL to extract audio from.
 * @param {string} gcsFileName - The destination filename to use in GCS.
 * @returns {Promise<string>} Resolves to the GCS URI (e.g. 'gs://bucket-name/file-name').
 * @throws {Error} If no valid download link is found or if upload fails.
 */
export async function streamAudioToGCS(youtubeUrl, gcsFileName) {
  console.log('-> 🎵 Searching for audio link and streaming directly to GCS...');

  const ytmp3Result = await yt.ytmp3(youtubeUrl, 128);
  if (
    !ytmp3Result.status ||
    typeof ytmp3Result.download !== 'object' ||
    typeof ytmp3Result.download.url !== 'string' ||
    ytmp3Result.download.url.length === 0
  ) {
    throw new Error('Unable to find a valid audio download link.');
  }

  const downloadUrl = ytmp3Result.download.url;
  console.log(`-> 🔗 Found download URL: ${downloadUrl.substring(0, 50)}...`);

  return new Promise((resolve, reject) => {
    const bucket = storageClient.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(gcsFileName);

    const gcsWriteStream = file.createWriteStream({
      metadata: {
        contentType: 'audio/mp3',
      },
    });

    gcsWriteStream.on('error', (err) => {
      console.error('GCS Write Stream error:', err.message);
      reject(new Error('Failed to write to Google Cloud Storage. Check GCS permissions.'));
    });

    gcsWriteStream.on('finish', () => {
      const gcsUri = `gs://${GCS_BUCKET_NAME}/${gcsFileName}`;
      console.log(`-> ✅ Successfully streamed and wrote to GCS: ${gcsUri}`);
      resolve(gcsUri);
    });

    const request = https.get(downloadUrl, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        request.destroy();
        return reject(
          new Error(
            `HTTP error downloading audio (${response.statusCode}): ${response.statusMessage}`
          )
        );
      }

      response.pipe(gcsWriteStream);
    });

    request.on('error', (err) => {
      gcsWriteStream.end();
      reject(err);
    });
  });
}

/**
 * Transcribe an audio file stored on GCS using Google Cloud Speech-to-Text
 * Long Running Recognize. This function enables word-level time offsets
 * and speaker diarization and returns a time-stamped transcription string.
 *
 * @param {string} gcsUri - The GCS URI of the audio file (e.g. 'gs://bucket/file.mp3').
 * @returns {Promise<string>} Resolves to the transcription with timestamps.
 * @throws {Error} When recognition fails or API returns an error.
 */
export async function transcribeAudio(gcsUri) {
  console.log('-> 🗣️ Sending long-running recognition request to Speech-to-Text API with time offsets enabled...');

  const audio = {
    uri: gcsUri,
  };

  const config = {
    encoding: 'MP3',
    languageCode: 'vi-VN',
    enableAutomaticPunctuation: true,
    enableSpeakerDiarization: true,
    sampleRateHertz: 44100,
    enableWordTimeOffsets: true,
  };

  const request = {
    audio: audio,
    config: config,
  };

  try {
    const [operation] = await speechClient.longRunningRecognize(request);

    console.log('-> ⏳ Waiting for recognition results (this may take several minutes)...');

    const [response] = await operation.promise();

    let detailedTranscription = '';

    response.results.forEach((result) => {
      if (result.alternatives[0].words) {
        result.alternatives[0].words.forEach((word) => {
          const totalSeconds = parseInt(word.startTime.seconds || 0);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          const formattedTime = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;

          detailedTranscription += `${formattedTime} ${word.word} `;
        });
        detailedTranscription += '\n';
      } else {
        detailedTranscription += result.alternatives[0].transcript + '\n';
      }
    });

    console.log('-> ✅ Transcription completed.');
    return detailedTranscription.trim();
  } catch (error) {
    console.error('Error during Long Running Recognize:', error.message);
    throw new Error('Speech-to-Text error. Check GCS config, permissions and audio format.');
  }
}

/**
 * Send a transcribed text to Gemini (Google GenAI) to produce a detailed summary.
 * The prompt instructs Gemini to create a Vietnamese, structured, timestamped and
 * highly-detailed summary divided into logical sections.
 *
 * @param {string} text - The transcript text to summarize.
 * @returns {Promise<string>} Resolves to the summary text returned by Gemini.
 * @throws {Error} If the Gemini/GenAI call fails.
 */
export async function summarizeTextWithGemini(text) {
  console.log('-> 🧠 Sending text to Gemini for summarization...');

  const prompt = basePrompt + `
    Here is the transcribed text from the video:

    ---
    ${text}
    ---
    `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: prompt,
    });

    console.log('-> ✅ Summary generation completed by Gemini.');
    return response.text;
  } catch (error) {
    console.error('Error summarizing with Gemini:', error.message);
    throw error;
  }
}

/**
 * Request Gemini to summarize a video file directly (by file URI).
 * NOTE: Gemini/GenAI file handling often requires uploading the file first
 * and passing a file identifier — passing raw gs:// URIs may not be supported
 * by the API. Keep that in mind when calling this function.
 *
 * @param {string} uri - The file URI or file identifier accepted by GenAI (e.g. a fileId or http(s) URL).
 * @param {string} prompt - The user prompt or instructions to accompany the file.
 * @returns {Promise<string>} Resolves to the generated summary text.
 * @throws {Error} If the GenAI call fails.
 */
export async function summarizeVideoWithGemini(uri) {
  const contents = [
    { text: basePrompt },
    {
      fileData: {
        mimeType: 'video/mp4',
        fileUri: uri,
      },
    },
  ];
  const response = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{ role: "user", parts: contents }] 
    });

  return response.text;
}

/**
 * Delete a temporary file from the configured GCS bucket.
 * Safe to call even if gcsFileName is falsy.
 *
 * @param {string} gcsFileName - The filename in the GCS bucket to delete.
 * @returns {Promise<void>}
 */
export async function deleteGCSFile(gcsFileName) {
  if (!gcsFileName) return;
  try {
    await storageClient.bucket(GCS_BUCKET_NAME).file(gcsFileName).delete();
    console.log(`-> Deleted temporary file on GCS: ${gcsFileName}`);
  } catch (e) {
    console.warn(
      `Warning: Unable to delete GCS file ${gcsFileName}. Please check Storage Object Deleter permissions.`
    );
  }
}

/**
 * Convert plain text to an MP3 audio buffer using Google Cloud Text-to-Speech.
 *
 * @param {string} text - The text to synthesize.
 * @returns {Promise<Buffer>} Resolves to an MP3 audio buffer.
 * @throws {Error} If the TTS call fails.
 */
export async function generateSpeechAudio(text) {
  console.log('-> 🎤 Sending text to Google Cloud Text-to-Speech...');

  const request = {
    input: { text: text },
    voice: { languageCode: 'vi-VN', name: 'vi-VN-Neural2-A' },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 1.25 },
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);
    console.log('-> ✅ Text-to-Speech completed, returning audio buffer.');
    return response.audioContent;
  } catch (error) {
    console.error('Error calling Google Cloud Text-to-Speech:', error.message);
    throw new Error('Failed to synthesize speech from text.');
  }
}
