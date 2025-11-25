import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import {
  streamAudioToGCS,
  transcribeAudio,
  summarizeTextWithGemini,
  summarizeVideoWithGemini,
  deleteGCSFile,
  generateSpeechAudio,
} from './gcp-core.js';
import { delay } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const jobRegistry = new Map();
const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

/**
 * Update the status of a job stored in jobRegistry.
 * @param {string} jobId - The job ID.
 * @param {string} status - The new status.
 */
function updateJobStatus(jobId, status) {
  const job = jobRegistry.get(jobId);
  if (job) {
    jobRegistry.set(jobId, { ...job, status: status });
    console.log(`[Job ${jobId}] Status updated to: ${status}`);
  }
}

/**
 * Main processing flow: Stream audio → Transcribe → Summarize.
 * This function orchestrates the full pipeline for audio-based summarization.
 *
 * @param {string} youtubeUrl - The YouTube video URL.
 * @param {string} jobId - Job ID used to track status.
 * @returns {Promise<string>} - The generated summary.
 */
async function mainFlow(youtubeUrl, jobId) {
  const gcsFileName = `youtube_audio_${Date.now()}.mp3`;
  let gcsUri = null;
  let rawSummary = null;

  try {
    console.log(`\n--- Starting process for URL: ${youtubeUrl} ---`);

    updateJobStatus(jobId, 'STREAMING');
    gcsUri = await streamAudioToGCS(youtubeUrl, gcsFileName);

    updateJobStatus(jobId, 'TRANSCRIBING');
    const transcribedText = await transcribeAudio(gcsUri);

    console.log(
      `\n-> Preview transcribed text (${transcribedText.length} chars):\n"${transcribedText.substring(0, 500)}..."`
    );

    const MAX_RETRIES = 5;
    const initialDelay = 1000;

    updateJobStatus(jobId, 'SUMMARIZING');

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const waitTime =
            initialDelay * Math.pow(2, attempt - 1) + Math.random() * 500;

          console.log(
            `-> ⚠️ 503/429 Error. Retry ${attempt + 1}/${MAX_RETRIES} after ${(waitTime / 1000).toFixed(2)} seconds...`
          );
          await delay(waitTime);
        }

        rawSummary = await summarizeTextWithGemini(transcribedText);
        break;
      } catch (error) {
        const retryable =
          error.message &&
          (error.message.includes('503') ||
            error.message.includes('429') ||
            error.message.includes('408'));

        if (retryable) {
          if (attempt === MAX_RETRIES - 1) {
            console.error(`❌ Exceeded maximum retry attempts (${MAX_RETRIES}).`);
            throw error;
          }
        } else {
          console.error('❌ Non-retryable error:', error.message);
          throw error;
        }
      }
    }

    if (!rawSummary) {
      throw new Error('Summary generation failed due to persistent API errors.');
    }

    console.log('\n=================================================');
    console.log('✅ FINAL SUMMARY (Gemini):\n');
    console.log(rawSummary);
    console.log('=================================================');

    return rawSummary;
  } catch (error) {
    console.error('\n❌ Pipeline error:', error.message);
    throw error;
  } finally {
    deleteGCSFile(gcsFileName);
    console.log('--- Pipeline finished ---');
  }
}

/**
 * Main video summarization pipeline (no transcription).
 * This summarization is done directly on the video (future use).
 *
 * @param {string} youtubeUrl - The YouTube video URL.
 * @param {string} jobId - Job ID for status tracking.
 * @returns {Promise<string>} - The generated summary.
 */
async function mainFlowVideo(youtubeUrl, jobId) {
  let rawSummary = null;

  try {
    console.log(`\n--- Starting process for URL: ${youtubeUrl} ---`);

    updateJobStatus(jobId, 'SUMMARIZING');
    const MAX_RETRIES = 5;
    const initialDelay = 1000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const waitTime =
            initialDelay * Math.pow(2, attempt - 1) + Math.random() * 500;

          console.log(
            `-> ⚠️ 503/429 Error. Retry ${attempt + 1}/${MAX_RETRIES} after ${(waitTime / 1000).toFixed(2)} seconds...`
          );
          await delay(waitTime);
        }

        rawSummary = await summarizeVideoWithGemini(youtubeUrl);
        break;
      } catch (error) {
        const retryable =
          error.message &&
          (error.message.includes('503') ||
            error.message.includes('429') ||
            error.message.includes('408'));

        if (retryable) {
          if (attempt === MAX_RETRIES - 1) {
            console.error(`❌ Exceeded maximum retry attempts (${MAX_RETRIES}).`);
            throw error;
          }
        } else {
          console.error('❌ Non-retryable error:', error.message);
          throw error;
        }
      }
    }

    if (!rawSummary) {
      throw new Error('Summary generation failed due to persistent API errors.');
    }

    console.log('\n=================================================');
    console.log('✅ FINAL VIDEO SUMMARY (Gemini):\n');
    console.log(rawSummary);
    console.log('=================================================');

    return rawSummary;
  } catch (error) {
    console.error('\n❌ Pipeline error:', error.message);
    throw error;
  } finally {
    console.log('--- Pipeline finished ---');
  }
}

/**
 * Endpoint to request audio-based YouTube summarization.
 */
app.post('/summarize', async (req, res) => {
  const { youtubeUrl } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'Missing YouTube URL.' });
  }

  const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  jobRegistry.set(jobId, { status: 'PENDING', result: null, error: null });

  console.log(`\n--- 🚀 New request received. Job ID: ${jobId} ---`);

  res.status(202).json({
    message: 'Request accepted and is processing in the background.',
    jobId,
    statusUrl: `/status/${jobId}`,
  });

  mainFlow(youtubeUrl, jobId)
    .then((summary) => {
      jobRegistry.set(jobId, { status: 'COMPLETED', result: summary, error: null });
      console.log(`--- ✅ Job ${jobId} completed ---`);
    })
    .catch((error) => {
      jobRegistry.set(jobId, { status: 'FAILED', result: null, error: error.message });
      console.error(`--- ❌ Job ${jobId} failed: ${error.message} ---`);
    });
});

/**
 * Endpoint for video-based summarization (Gemini directly on video).
 */
app.post('/summarize-video', async (req, res) => {
  const { youtubeUrl } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'Missing YouTube URL.' });
  }

  const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  jobRegistry.set(jobId, { status: 'PENDING', result: null, error: null });

  console.log(`\n--- 🚀 New request received. Job ID: ${jobId} ---`);

  res.status(202).json({
    message: 'Request accepted and is processing in the background.',
    jobId,
    statusUrl: `/status/${jobId}`,
  });

  mainFlowVideo(youtubeUrl, jobId)
    .then((summary) => {
      jobRegistry.set(jobId, { status: 'COMPLETED', result: summary, error: null });
      console.log(`--- ✅ Job ${jobId} completed ---`);
    })
    .catch((error) => {
      jobRegistry.set(jobId, { status: 'FAILED', result: null, error: error.message });
      console.error(`--- ❌ Job ${jobId} failed: ${error.message} ---`);
    });
});

/**
 * Endpoint to get current job status or final result.
 */
app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobRegistry.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job ID not found.' });
  }

  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    res.json(job);

    setTimeout(() => {
      jobRegistry.delete(jobId);
      console.log(`--- Removed job ${jobId} from registry ---`);
    }, 5000);
  } else {
    res.json(job);
  }
});

/**
 * Text-to-speech endpoint using Gemini / GCP.
 */
app.post('/speak', async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).send('Missing text for conversion.');
  }

  try {
    const audioBuffer = await generateSpeechAudio(text);

    res.set('Content-Type', 'audio/mp3');
    res.set('Content-Length', audioBuffer.length);

    res.send(audioBuffer);
  } catch (error) {
    console.error('Error in /speak:', error.message);
    res.status(500).send('Server error while generating audio.');
  }
});

/**
 * Start the Express server.
 */
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/index.html`);
});
