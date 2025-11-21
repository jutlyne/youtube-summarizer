import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import {
  streamAudioToGCS,
  transcribeAudio,
  summarizeTextWithGemini,
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
 * Cập nhật trạng thái của công việc trong jobRegistry (Giữ lại ở đây để truy cập jobRegistry).
 * @param {string} jobId ID của công việc.
 * @param {string} status Trạng thái mới.
 */
function updateJobStatus(jobId, status) {
  const job = jobRegistry.get(jobId);
  if (job) {
    jobRegistry.set(jobId, { ...job, status: status });
    console.log(`[Job ${jobId}] Status updated to: ${status}`);
  }
}

/**
 * Chạy toàn bộ quy trình: Stream audio -> Chép lời -> Tóm tắt.
 * Hàm này là hàm điều phối chính.
 * @param {string} youtubeUrl URL của video YouTube.
 * @param {string} jobId ID của công việc để cập nhật trạng thái.
 */
async function mainFlow(youtubeUrl, jobId) {
  const gcsFileName = `youtube_audio_${Date.now()}.mp3`;
  let gcsUri = null;
  let rawSummary = null;

  try {
    console.log(`\n--- Bắt đầu xử lý URL: ${youtubeUrl} ---`);

    updateJobStatus(jobId, 'STREAMING');
    gcsUri = await streamAudioToGCS(youtubeUrl, gcsFileName);

    updateJobStatus(jobId, 'TRANSCRIBING');
    const transcribedText = await transcribeAudio(gcsUri);

    console.log(
      `\n-> Xem trước nội dung đã chuyển đổi (${
        transcribedText.length
      } ký tự):\n"${transcribedText.substring(0, 500)}..."`
    );

    const MAX_RETRIES = 5;
    let initialDelay = 1000;

    updateJobStatus(jobId, 'SUMMARIZING');
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const waitTime =
            initialDelay * Math.pow(2, attempt - 1) + Math.random() * 500;

          console.log(
            `-> ⚠️ Lỗi 503/429. Thử lại lần ${
              attempt + 1
            }/${MAX_RETRIES} sau ${(waitTime / 1000).toFixed(2)} giây...`
          );
          await delay(waitTime);
        }

        rawSummary = await summarizeTextWithGemini(transcribedText);

        break;
      } catch (error) {
        const isRetryableError =
          error.message &&
          (error.message.includes('503 Service Unavailable') ||
            error.message.includes('429 Too Many Requests') ||
            error.message.includes('408 Request Timeout'));

        if (isRetryableError) {
          if (attempt === MAX_RETRIES - 1) {
            console.error(
              `❌ Đã vượt quá số lần thử lại tối đa (${MAX_RETRIES}).`
            );
            throw error;
          }
        } else {
          console.error(
            '❌ Lỗi không thể thử lại (Non-retryable Error):',
            error.message
          );
          throw error;
        }
      }
    }

    if (!rawSummary) {
      throw new Error('Không thể tạo tóm tắt do lỗi API kéo dài.');
    }

    console.log('\n=================================================');
    console.log('✅ TÓM TẮT NỘI DUNG CUỐI CÙNG (Sử dụng Gemini):\n');
    console.log(rawSummary);
    console.log('=================================================');
    return rawSummary;
  } catch (error) {
    console.error('\n❌ Đã xảy ra lỗi trong quy trình:', error.message);
    throw error;
  } finally {
    deleteGCSFile(gcsFileName);
    console.log('--- Kết thúc quy trình ---');
  }
}

app.post('/summarize', async (req, res) => {
  const { youtubeUrl } = req.body;

  if (!youtubeUrl) {
    return res.status(400).json({ error: 'Thiếu URL YouTube.' });
  }

  const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  jobRegistry.set(jobId, { status: 'PENDING', result: null, error: null });

  console.log(`\n--- 🚀 Đã nhận yêu cầu mới. Job ID: ${jobId} ---`);

  res.status(202).json({
    message: 'Yêu cầu đã được chấp nhận và đang được xử lý ở chế độ nền.',
    jobId: jobId,
    statusUrl: `/status/${jobId}`,
  });

  mainFlow(youtubeUrl, jobId)
    .then((summary) => {
      jobRegistry.set(jobId, {
        status: 'COMPLETED',
        result: summary,
        error: null,
      });
      console.log(`--- ✅ Job ${jobId} hoàn thành ---`);
    })
    .catch((error) => {
      jobRegistry.set(jobId, {
        status: 'FAILED',
        result: null,
        error: error.message,
      });
      console.error(`--- ❌ Job ${jobId} thất bại: ${error.message} ---`);
    });
});

app.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobRegistry.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Không tìm thấy Job ID này.' });
  }

  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    res.json(job);

    setTimeout(() => {
      jobRegistry.delete(jobId);
      console.log(`--- Đã xóa Job ${jobId} khỏi registry ---`);
    }, 5000);
  } else {
    res.json(job);
  }
});

app.post('/speak', async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).send('Thiếu văn bản để chuyển đổi.');
  }

  try {
    const audioBuffer = await generateSpeechAudio(text);

    res.set('Content-Type', 'audio/mp3');
    res.set('Content-Length', audioBuffer.length);

    res.send(audioBuffer);
  } catch (error) {
    console.error('Lỗi xử lý /speak:', error.message);
    res.status(500).send('Lỗi máy chủ khi tạo audio.');
  }
});

app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
  console.log(`Mở trình duyệt và truy cập http://localhost:${PORT}/index.html`);
});
