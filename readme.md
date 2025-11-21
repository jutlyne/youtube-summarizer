# 🚀 YouTube Video Summarizer (GCP & Gemini)

This project is a powerful backend application built with **Node.js/Express** that automates the process of extracting, transcribing, and summarizing long YouTube videos. It leverages several **Google Cloud Platform (GCP)** services and the **Gemini API** for high-quality audio processing and textual analysis.

## ✨ Features

* **Asynchronous Processing:** Handles video processing in the background, allowing the client to poll for status updates.
* **YouTube Audio Extraction:** Streams audio directly from a YouTube URL.
* **Google Cloud Storage (GCS):** Securely uploads temporary audio files for transcription.
* **Speech-to-Text (STT):** Uses Google Cloud Speech-to-Text to transcribe audio into text, including detailed timestamps.
* **Gemini Summarization:** Utilizes the Gemini API to analyze the full transcript and generate concise, structured summaries.
* **Error Handling:** Implements an exponential backoff retry mechanism for handling transient API errors (e.g., 503/429) during summarization.
* **Text-to-Speech (TTS):** Provides an endpoint to convert the summary text into high-quality MP3 audio using Google Cloud Text-to-Speech (supporting multiple languages).
* **Clean-up:** Automatically deletes temporary audio files from GCS after processing is complete.

## 🛠️ Technology Stack

* **Backend:** Node.js, Express
* **AI/ML:** Google Gemini API
* **GCP Services:**
    * Google Cloud Speech-to-Text (STT)
    * Google Cloud Storage (GCS)
    * Google Cloud Text-to-Speech (TTS)
* **Deployment:** PM2 (for process management)

## ⚙️ Setup and Configuration

### 1. Prerequisites

* Node.js (LTS version)
* A Google Cloud Project with Billing enabled.
* Activated APIs in your GCP project:
    * **Cloud Speech-to-Text API**
    * **Cloud Storage API**
    * **Generative Language API** (for Gemini)
    * **Cloud Text-to-Speech API**

### 2. Service Account Setup

1.  Create a Service Account and download the JSON key file.
2.  Set the environment variable pointing to the key file, or place the file in the project root (e.g., `key.json`).

### 3. Environment Variables (Example)

Create a `.env` file or export the following variables (used in `gcp-core.js`):

### 4. Installation

Clone the repository and install dependencies:

```bash
npm install
```

### 5. Running the Application

Local Development

```bash
node index.js
```

Production with PM2 (Recommended)

```bash
# Example command to allocate 2GB Heap and 2.4GB Total RAM
pm2 start index.js --name "ytb-prod" --node-args="--max-old-space-size=2048 --expose-gc" --max-memory-restart 2400M
pm2 save
```
