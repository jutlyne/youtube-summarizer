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
const PORT = 3000;

const app = express();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

const jobManager = {
  registry: new Map(),

  create(jobId) {
    this.registry.set(jobId, { status: 'PENDING', result: null, error: null });
  },

  get(jobId) {
    return this.registry.get(jobId);
  },

  updateStatus(jobId, status) {
    const job = this.registry.get(jobId);
    if (job) {
      this.registry.set(jobId, { ...job, status });
      console.log(`[Job ${jobId}] Status updated to: ${jobId}`);
    }
  },

  complete(jobId, result) {
    this.registry.set(jobId, { status: 'COMPLETED', result, error: null });
    console.log(`--- ✅ Job ${jobId} completed ---`);
  },

  fail(jobId, errorMsg) {
    this.registry.set(jobId, { status: 'FAILED', result: null, error: errorMsg });
    console.error(`--- ❌ Job ${jobId} failed: ${errorMsg} ---`);
  },

  delete(jobId) {
    this.registry.delete(jobId);
    console.log(`--- Removed job ${jobId} from registry ---`);
  }
};

async function executeWithRetry(operationFn, contextInfo) {
  const MAX_RETRIES = 5;
  const INITIAL_DELAY = 1000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const waitTime = INITIAL_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.log(`-> ⚠️ 503/429 Error. Retry ${attempt + 1}/${MAX_RETRIES} after ${(waitTime / 1000).toFixed(2)}s...`);
        await delay(waitTime);
      }
      
      return await operationFn();

    } catch (error) {
      const isRetryable = error.message && (
        error.message.includes('503') || 
        error.message.includes('429') || 
        error.message.includes('408')
      );

      if (!isRetryable) {
        console.error(`❌ Non-retryable error in ${contextInfo}:`, error.message);
        throw error;
      }

      if (attempt === MAX_RETRIES - 1) {
        console.error(`❌ Exceeded maximum retry attempts (${attempt + 1}) in ${contextInfo}.`);
        throw error;
      }
    }
  }
  throw new Error(`Operation failed after retries: ${contextInfo}`);
}

async function pipelineAudioSummarization(youtubeUrl, jobId) {
  const gcsFileName = `youtube_audio_${Date.now()}.mp3`;
  let gcsUri = null;

  try {
    console.log(`\n--- Starting Audio Pipeline for URL: ${youtubeUrl} ---`);

    jobManager.updateStatus(jobId, 'STREAMING');
    gcsUri = await streamAudioToGCS(youtubeUrl, gcsFileName);

    jobManager.updateStatus(jobId, 'TRANSCRIBING');
    const transcribedText = await transcribeAudio(gcsUri);

    console.log(`\n-> Preview text (${transcribedText.length} chars):\n"${transcribedText.substring(0, 500)}..."`);

    jobManager.updateStatus(jobId, 'SUMMARIZING');
    const summary = await executeWithRetry(
      () => summarizeTextWithGemini(transcribedText), 
      'Summarize Text'
    );

    if (!summary) throw new Error('Summary generation returned empty result.');

    return summary;

  } catch (error) {
    console.error('\n❌ Pipeline Audio error:', error.message);
    throw error;
  } finally {
    if (gcsFileName) deleteGCSFile(gcsFileName);
  }
}

async function pipelineVideoSummarization(youtubeUrl, jobId) {
  try {
    console.log(`\n--- Starting Video Pipeline for URL: ${youtubeUrl} ---`);

    jobManager.updateStatus(jobId, 'SUMMARIZING');

    const summary = await executeWithRetry(
      () => summarizeVideoWithGemini(youtubeUrl), 
      'Summarize Video'
    );

    if (!summary) throw new Error('Summary generation returned empty result.');

    return summary;

  } catch (error) {
    console.error('\n❌ Pipeline Video error:', error.message);
    throw error;
  }
}

const handleSummarizeRequest = (pipelineFn) => async (req, res) => {
  const { youtubeUrl } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'Missing YouTube URL.' });
  }

  const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  jobManager.create(jobId);

  console.log(`\n--- 🚀 New request received. Job ID: ${jobId} ---`);

  res.status(202).json({
    message: 'Request accepted and is processing in the background.',
    jobId,
    statusUrl: `/status/${jobId}`,
  });

  pipelineFn(youtubeUrl, jobId)
    .then((summary) => {
      console.log('\n=================================================');
      console.log(`✅ FINAL SUMMARY (Job ${jobId}):\n`, summary);
      console.log('=================================================');
      jobManager.complete(jobId, summary);
    })
    .catch((error) => {
      jobManager.fail(jobId, error.message);
    });
};

app.post('/summarize', handleSummarizeRequest(pipelineAudioSummarization));

app.post('/summarize-video', handleSummarizeRequest(pipelineVideoSummarization));

app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobManager.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job ID not found.' });
  }

  res.json(job);

  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    setTimeout(() => {
      jobManager.delete(jobId);
    }, 5000);
  }
});

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

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/index.html`);
});