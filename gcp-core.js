import 'dotenv/config'
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

export const GCS_BUCKET_NAME = 'youtube-audio-bucket-kyvc';

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

/**
 * Lấy URL audio từ YouTube và truyền tải trực tiếp lên GCS.
 * KHÔNG LƯU FILE CỤC BỘ.
 * @param {string} youtubeUrl URL của video YouTube.
 * @param {string} gcsFileName Tên file sẽ được lưu trên GCS.
 * @returns {Promise<string>} Promise resolve với URI GCS (vd: 'gs://bucket-name/file-name').
 */
export async function streamAudioToGCS(youtubeUrl, gcsFileName) {
  console.log(
    '-> 🎵 Đang tìm kiếm link audio và truyền tải trực tiếp lên GCS...'
  );

  const ytmp3Result = await yt.ytmp3(youtubeUrl, 128);
  if (
    !ytmp3Result.status ||
    typeof ytmp3Result.download !== 'object' ||
    typeof ytmp3Result.download.url !== 'string' ||
    ytmp3Result.download.url.length === 0
  ) {
    throw new Error('Không thể tìm thấy link tải audio hợp lệ.');
  }

  const downloadUrl = ytmp3Result.download.url;
  console.log(
    `-> 🔗 Đã tìm thấy URL tải xuống: ${downloadUrl.substring(0, 50)}...`
  );

  return new Promise((resolve, reject) => {
    const bucket = storageClient.bucket(GCS_BUCKET_NAME);
    const file = bucket.file(gcsFileName);

    const gcsWriteStream = file.createWriteStream({
      metadata: {
        contentType: 'audio/mp3',
      },
    });

    gcsWriteStream.on('error', (err) => {
      console.error('Lỗi GCS Write Stream:', err.message);
      reject(
        new Error('Lỗi khi ghi vào Google Cloud Storage. Kiểm tra quyền GCS.')
      );
    });

    gcsWriteStream.on('finish', () => {
      const gcsUri = `gs://${GCS_BUCKET_NAME}/${gcsFileName}`;
      console.log(`-> ✅ Truyền tải và ghi vào GCS thành công: ${gcsUri}`);
      resolve(gcsUri);
    });

    const request = https.get(downloadUrl, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        request.destroy();
        return reject(
          new Error(
            `Lỗi HTTP khi tải audio (${response.statusCode}): ${response.statusMessage}`
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
 * Chuyển đổi file audio GCS thành văn bản tiếng Việt sử dụng Long Running Recognition,
 * trích xuất cả dấu thời gian.
 * @param {string} gcsUri URI GCS của file audio.
 * @returns {Promise<string>} Promise resolve với bản chép lời kèm dấu thời gian.
 */
export async function transcribeAudio(gcsUri) {
  console.log(
    '-> 🗣️ Đang gửi yêu cầu nhận dạng dài hạn (Long Running Recognition) tới Speech-to-Text API, ĐÃ KÍCH HOẠT DẤU THỜI GIAN...'
  );

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

    console.log(
      '-> ⏳ Đang chờ kết quả nhận dạng từ API (có thể mất vài phút)...'
    );

    const [response] = await operation.promise();

    let detailedTranscription = '';

    response.results.forEach((result) => {
      if (result.alternatives[0].words) {
        result.alternatives[0].words.forEach((word) => {
          const totalSeconds = parseInt(word.startTime.seconds);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          const formattedTime = `[${minutes
            .toString()
            .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;

          detailedTranscription += `${formattedTime} ${word.word} `;
        });
        detailedTranscription += '\n';
      } else {
        detailedTranscription += result.alternatives[0].transcript + '\n';
      }
    });

    console.log('-> ✅ Chuyển text hoàn tất.');
    return detailedTranscription.trim();
  } catch (error) {
    console.error(
      'Lỗi khi chuyển text bằng Long Running Recognize:',
      error.message
    );
    throw new Error(
      'Lỗi Speech-to-Text. Kiểm tra cấu hình GCS, quyền truy cập và định dạng audio.'
    );
  }
}

/**
 * Gửi bản chép lời cho Gemini để tóm tắt nội dung chính.
 * @param {string} text Văn bản cần tóm tắt.
 * @returns {Promise<string>} Promise resolve với bản tóm tắt.
 */
export async function summarizeTextWithGemini(text) {
  console.log('-> 🧠 Đang gửi text cho Gemini để tóm tắt...');

  const prompt = `
    Bạn là một trợ lý tóm tắt nội dung video chuyên nghiệp.
    Hãy tóm tắt văn bản đã được chép lời sau đây. Bản tóm tắt của bạn phải:
    1. Sử dụng tiếng Việt.
    2. Cực kỳ chi tiết, rõ ràng và cô đọng, tập trung vào các sự kiện, quan sát và điểm nhấn chính.
    3. Bắt buộc phải **phân đoạn nội dung** thành các mục lớn và mục nhỏ, dựa trên chủ đề (ví dụ: Giới Thiệu, Quan Sát, Trải Nghiệm, Tiết Lộ Giá Cả, Kết Luận...).
    4. **BẮT BUỘC** trích dẫn dấu thời gian ([phút:giây] hoặc [phút:giây]–[phút:giây]) ngay sau mỗi ý chính hoặc nhóm ý chính.

    Cấu trúc Tóm tắt đề xuất:
    - Tên Tóm Tắt (ví dụ: Tóm Tắt Nội Dung Video)
    - Mục 1: Giới Thiệu/Bối Cảnh (kèm timestamp)
    - Mục 2: Quan Sát Trên Đường Phố (kèm timestamp)
    - Mục 3: Trải Nghiệm Cụ Thể (ví dụ: Quán Bar, tương tác) (kèm timestamp)
    - Mục 4: Tiết Lộ Giá Cả và Quan Điểm Cá Nhân (kèm timestamp)
    - Mục 5: Kết Thúc/Quan Sát Cuối Cùng (kèm timestamp)

    Dưới đây là văn bản đã chép lời từ video:

    ---
    ${text}
    ---
    `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    console.log('-> ✅ Tóm tắt hoàn tất bằng Gemini.');
    return response.text;
  } catch (error) {
    console.error('Lỗi khi tóm tắt bằng Gemini:', error.message);
    throw error;
  }
}

/**
 * Xóa file trên GCS sau khi xử lý xong.
 * @param {string} gcsFileName Tên file trên GCS.
 */
export async function deleteGCSFile(gcsFileName) {
  if (!gcsFileName) return;
  try {
    await storageClient.bucket(GCS_BUCKET_NAME).file(gcsFileName).delete();
    console.log(`-> Đã xóa file tạm thời trên GCS: ${gcsFileName}`);
  } catch (e) {
    console.warn(
      `Cảnh báo: Không thể xóa file GCS ${gcsFileName}. Vui lòng kiểm tra quyền Storage Object Deleter.`
    );
  }
}

/**
 * Sử dụng Google Cloud Text-to-Speech để chuyển văn bản thành audio buffer.
 * @param {string} text Văn bản cần chuyển thành giọng nói.
 * @returns {Promise<Buffer>} Buffer chứa dữ liệu audio MP3.
 */
export async function generateSpeechAudio(text) {
  console.log('-> 🎤 Đang gửi text cho Google Cloud Text-to-Speech...');

  const request = {
    input: { text: text },
    voice: { languageCode: 'vi-VN', name: 'vi-VN-Neural2-A' },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 1.25 },
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);
    console.log('-> ✅ Text-to-Speech hoàn tất, trả về audio buffer.');
    return response.audioContent;
  } catch (error) {
    console.error('Lỗi khi gọi Google Cloud Text-to-Speech:', error.message);
    throw new Error('Không thể tạo giọng nói từ văn bản.');
  }
}
