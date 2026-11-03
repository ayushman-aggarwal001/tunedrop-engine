
import JSZip from 'jszip';
import './style.css';

import {
  loadDemucsModel,
  separateStems,
  extractStems
} from './demucs-loader.js';

const TARGET_SAMPLE_RATE = 44100;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const $ = (id) => document.getElementById(id);

const dropZone = $('drop-zone');
const fileInput = $('file-input');
const sourcePlayer = $('source-player');
const sourceAudio = $('source-audio');
const sourceInfo = $('source-info');
const statusEl = $('status');
const separateBtn = $('separate-btn');
const stemGrid = $('stem-cards');
const downloadAll = $('download-all');
const playAllBtn = $('play-all');
const spoolLeft = $('spool-left');
const spoolRight = $('spool-right');

let currentFile = null;
let modelSession = null;
let modelPromise = null;

let audioContext = null;
let activeSources = [];
let stemBuffers = {};
let stemBlobs = {};
let stemUrls = {};
let isPlaying = false;

const STEMS = ['vocals', 'drums', 'bass', 'other'];

const LABELS = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Other Instruments'
};

function setStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.style.color = error ? 'var(--accent)' : '';
}

function startSpools() {
  spoolLeft?.classList.add('spinning');
  spoolRight?.classList.add('spinning');
}

function stopSpools() {
  spoolLeft?.classList.remove('spinning');
  spoolRight?.classList.remove('spinning');
}

function resetResults() {
  stopAll();

  for (const url of Object.values(stemUrls)) {
    URL.revokeObjectURL(url);
  }

  stemBuffers = {};
  stemBlobs = {};
  stemUrls = {};

  stemGrid.innerHTML = '';
  downloadAll.style.display = 'none';
  playAllBtn.style.display = 'none';
}

function handleFile(file) {
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    setStatus('File too large. Maximum size is 10 MB.', true);
    return;
  }

  if (
    !file.type.startsWith('audio/') &&
    !/\.(wav|mp3|m4a|ogg|flac)$/i.test(file.name)
  ) {
    setStatus('Unsupported file. Please choose an audio file.', true);
    return;
  }

  resetResults();

  currentFile = file;

  if (sourceAudio.src.startsWith('blob:')) {
    URL.revokeObjectURL(sourceAudio.src);
  }

  sourceAudio.src = URL.createObjectURL(file);
  sourcePlayer.style.display = 'block';
  sourceInfo.textContent =
    `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;

  separateBtn.style.display = 'block';
  separateBtn.disabled = false;
  separateBtn.textContent = '▶ Separate';

  setStatus('Your track is ready. Press Separate to begin.');
}

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (event) => {
  handleFile(event.target.files[0]);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(event.dataTransfer.files[0]);
});

// Load the model once and reuse it for future songs.
async function getModel() {
  if (modelSession) return modelSession;

  if (!modelPromise) {
    modelPromise = loadDemucsModel((progress) => {
      if (progress.stage === 'checking') {
        setStatus('Checking for a saved AI model...');
      } else if (progress.stage === 'downloading') {
        const pct = progress.percent ?? 0;
        const received = progress.received
          ? ` · ${(progress.received / 1048576).toFixed(1)} MB downloaded`
          : '';

        setStatus(`Downloading AI model: ${pct}%${received}`);
      } else if (progress.stage === 'loading') {
        setStatus('Loading AI model into your browser...');
      } else if (progress.stage === 'ready') {
        setStatus('AI model ready!');
      }
    });
  }

  try {
    modelSession = await modelPromise;
    return modelSession;
  } catch (error) {
    modelPromise = null;
    throw error;
  }
}

// Convert uploaded audio to stereo 44.1 kHz.
async function decodeAndResample(file) {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }

  const fileData = await file.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(fileData);

  const outputLength = Math.ceil(
    decoded.duration * TARGET_SAMPLE_RATE
  );

  const offline = new OfflineAudioContext(
    2,
    outputLength,
    TARGET_SAMPLE_RATE
  );

  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);

  return await offline.startRendering();
}

// Convert an AudioBuffer into a downloadable WAV file.
function audioBufferToWav(buffer) {
  const channels = buffer.numberOfChannels;
  const samples = buffer.length;
  const bytesPerSample = 2;

  const dataSize = samples * channels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(
    28,
    buffer.sampleRate * channels * bytesPerSample,
    true
  );
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = [];

  for (let c = 0; c < channels; c++) {
    channelData.push(buffer.getChannelData(c));
  }

  let offset = 44;

  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      const value = sample < 0
        ? sample * 32768
        : sample * 32767;

      view.setInt16(offset, value, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function displayStems(buffers) {
  stemGrid.innerHTML = '';

  for (const name of STEMS) {
    const buffer = buffers[name];
    if (!buffer) continue;

    const blob = audioBufferToWav(buffer);
    const url = URL.createObjectURL(blob);

    stemBuffers[name] = buffer;
    stemBlobs[name] = blob;
    stemUrls[name] = url;

    const card = document.createElement('div');
    card.className = 'stem-card';

    const heading = document.createElement('h3');
    heading.textContent = LABELS[name];

    const player = document.createElement('audio');
    player.controls = true;
    player.src = url;
    player.preload = 'none';

    const download = document.createElement('button');
    download.className = 'btn-stem-dl';
    download.textContent = 'Download WAV';

    download.addEventListener('click', () => {
      downloadBlob(blob, `${name}.wav`);
    });

    const mute = document.createElement('button');
    mute.className = 'btn-mute';
    mute.textContent = '🔊';
    mute.dataset.stem = name;
    mute.style.display = 'none';

    mute.addEventListener('click', () => toggleStemMute(name, mute));

    card.append(heading, player, download, mute);
    stemGrid.appendChild(card);
  }

  downloadAll.style.display = 'block';
  playAllBtn.style.display = 'block';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function processFile(file) {
  startSpools();
  resetResults();

  separateBtn.disabled = true;

  try {
    setStatus('Preparing your audio...');

    const audioData = await decodeAndResample(file);

    setStatus('Loading the Demucs AI model...');

    const session = await getModel();

    setStatus('Separating vocals and instruments...');

    const result = await separateStems(
      session,
      audioData,
      TARGET_SAMPLE_RATE,
      (progress) => {
        setStatus(
          `AI separation: ${progress.percent}% ` +
          `(chunk ${progress.chunk}/${progress.total})`
        );
      }
    );

    setStatus('Preparing your four audio tracks...');

    const buffers = extractStems(
      result,
      TARGET_SAMPLE_RATE,
      audioContext
    );

    displayStems(buffers);

    setStatus('Complete! Your four stems are ready to play and download.');
    separateBtn.style.display = 'none';

  } catch (error) {
    console.error(error);

    setStatus(
      `Separation failed: ${error.message || 'Unknown error'}`,
      true
    );

    separateBtn.disabled = false;
    separateBtn.textContent = '▶ Try Again';

  } finally {
    stopSpools();
  }
}

separateBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  await processFile(currentFile);
});

function stopAll() {
  for (const source of activeSources) {
    try {
      source.stop();
    } catch {
      // Source may already have stopped.
    }
  }

  activeSources = [];
  isPlaying = false;
  playAllBtn.textContent = '▶ Play All';

  document.querySelectorAll('.btn-mute').forEach((button) => {
    button.textContent = '🔊';
    button.classList.remove('muted');
  });
}

async function playAll() {
  if (isPlaying) {
    stopAll();
    return;
  }

  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  activeSources = [];

  for (const name of STEMS) {
    const buffer = stemBuffers[name];
    if (!buffer) continue;

    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const gain = audioContext.createGain();
    gain.gain.value = 1;

    source.connect(gain);
    gain.connect(audioContext.destination);

    activeSources.push({ source, gain, name });
  }

  if (!activeSources.length) return;

  let remaining = activeSources.length;
  isPlaying = true;
  playAllBtn.textContent = '⏹ Stop';

  activeSources.forEach(({ source }) => {
    source.onended = () => {
      remaining--;

      if (remaining === 0 && isPlaying) {
        stopAll();
      }
    };

    source.start(0);
  });
}

function toggleStemMute(name, button) {
  if (!isPlaying) return;

  const item = activeSources.find((entry) => entry.name === name);
  if (!item) return;

  const muted = item.gain.gain.value === 0;
  item.gain.gain.value = muted ? 1 : 0;

  button.textContent = muted ? '🔊' : '🔇';
  button.classList.toggle('muted', !muted);
}

playAllBtn.addEventListener('click', playAll);

downloadAll.addEventListener('click', async () => {
  if (!Object.keys(stemBlobs).length) return;

  const zip = new JSZip();

  for (const name of STEMS) {
    if (stemBlobs[name]) {
      zip.file(`${name}.wav`, stemBlobs[name]);
    }
  }

  setStatus('Creating your ZIP download...');

  try {
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(zipBlob, 'tunedrop-stems.zip');
    setStatus('Your ZIP download is ready!');
  } catch (error) {
    setStatus(`ZIP creation failed: ${error.message}`, true);
  }
});
