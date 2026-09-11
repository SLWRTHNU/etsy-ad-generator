// Etsy Listing Assistant — client-side logic.
// No build step: this is plain ES module JS, loaded directly by index.html.

import { downloadZip } from "https://cdn.jsdelivr.net/npm/client-zip@2.4.5/index.js";

const RESIZE_SIZES = [2000, 1080, 500];
const NOTES_SOFT_LIMIT = 2000;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

// --- DOM refs ---
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const uploadError = document.getElementById("upload-error");
const previewArea = document.getElementById("preview-area");
const previewImage = document.getElementById("preview-image");
const removeImageBtn = document.getElementById("remove-image-btn");
const resizeArea = document.getElementById("resize-area");
const resizeList = document.getElementById("resize-list");
const downloadZipBtn = document.getElementById("download-zip-btn");

const productTypeSelect = document.getElementById("product-type");
const notesTextarea = document.getElementById("notes");
const notesWarning = document.getElementById("notes-warning");

const generateBtn = document.getElementById("generate-btn");
const generateError = document.getElementById("generate-error");

const outputSection = document.getElementById("output-section");
const outputTitle = document.getElementById("output-title");
const titleCount = document.getElementById("title-count");
const outputDescription = document.getElementById("output-description");
const outputTags = document.getElementById("output-tags");
const copyAllTagsBtn = document.getElementById("copy-all-tags-btn");
const outputCategory = document.getElementById("output-category");
const outputAttributes = document.getElementById("output-attributes");
const listingNote = document.getElementById("listing-note");

// --- State ---
let originalFile = null;
let imageBase64 = null; // data URL sent to the API (full-size original)
let resizedFiles = {}; // { 2000: {blob, name}, 1080: {...}, 500: {...} }
let lastTags = [];

// --- Upload: drag & drop / click to browse ---
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
});

removeImageBtn.addEventListener("click", resetImage);

async function handleFile(file) {
  uploadError.hidden = true;

  if (!ACCEPTED_TYPES.includes(file.type)) {
    uploadError.textContent = "Unsupported file type. Please upload a JPG, PNG, or WEBP image.";
    uploadError.hidden = false;
    return;
  }

  try {
    originalFile = file;
    imageBase64 = await fileToDataUrl(file);
    previewImage.src = imageBase64;
    previewArea.hidden = false;

    await resizeAll(file);
    updateGenerateButtonState();
  } catch (err) {
    uploadError.textContent = "Couldn't read that image. Please try a different file.";
    uploadError.hidden = false;
    resetImage();
  }
}

function resetImage() {
  originalFile = null;
  imageBase64 = null;
  resizedFiles = {};
  fileInput.value = "";
  previewImage.src = "";
  previewArea.hidden = true;
  resizeArea.hidden = true;
  resizeList.innerHTML = "";
  downloadZipBtn.disabled = true;
  updateGenerateButtonState();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// --- Resize (Canvas API) ---
async function resizeAll(file) {
  const img = await loadImage(file);
  resizedFiles = {};
  resizeList.innerHTML = "";

  for (const size of RESIZE_SIZES) {
    const blob = await resizeImage(img, size);
    const name = `product-${size}px.jpg`;
    resizedFiles[size] = { blob, name };
    resizeList.appendChild(buildResizeRow(size, name, blob));
  }

  resizeArea.hidden = false;
  downloadZipBtn.disabled = false;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function resizeImage(img, maxDim, quality = 0.9) {
  const longestSide = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(1, maxDim / longestSide);
  const width = Math.round(img.naturalWidth * scale);
  const height = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

// Downscale + re-encode the photo before sending it to /api/generate.
// Claude's vision input downscales anything above ~1568px on the long edge
// anyway, so this loses no usable detail while keeping the base64 payload
// well under the 10MB image limit.
const API_IMAGE_MAX_DIM = 1568;
const API_IMAGE_QUALITY = 0.85;

async function buildApiImagePayload(file) {
  const img = await loadImage(file);
  const blob = await resizeImage(img, API_IMAGE_MAX_DIM, API_IMAGE_QUALITY);
  return fileToDataUrl(blob);
}

function buildResizeRow(size, name, blob) {
  const row = document.createElement("div");
  row.className = "resize-item";
  row.innerHTML = `
    <span>${name}</span>
    <span class="resize-item-size">${formatBytes(blob.size)}</span>
  `;
  return row;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

downloadZipBtn.addEventListener("click", async () => {
  const files = Object.values(resizedFiles).map(({ blob, name }) => ({
    name,
    input: blob,
  }));
  if (files.length === 0) return;

  const blob = await downloadZip(files).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "product-images.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// --- Notes soft warning ---
notesTextarea.addEventListener("input", () => {
  if (notesTextarea.value.length > NOTES_SOFT_LIMIT) {
    notesWarning.textContent = "That's a lot of detail — shorter notes plus the photo usually work just as well.";
    notesWarning.hidden = false;
  } else {
    notesWarning.hidden = true;
  }
  updateGenerateButtonState();
});

// Generate button is enabled once there's a photo, some notes text, or both —
// disabled only when both are empty.
function updateGenerateButtonState() {
  const hasImage = Boolean(originalFile);
  const hasNotes = notesTextarea.value.trim().length > 0;
  generateBtn.disabled = !hasImage && !hasNotes;
}

// --- Generate listing ---
generateBtn.addEventListener("click", async () => {
  generateError.hidden = true;

  const notes = notesTextarea.value.trim();
  if (!originalFile && !notes) {
    generateError.textContent = "Please upload a product photo or add some notes first.";
    generateError.hidden = false;
    return;
  }

  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="btn-spinner"></span> Generating…';

  try {
    const apiImage = originalFile ? await buildApiImagePayload(originalFile) : null;

    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: apiImage,
        notes,
        productType: productTypeSelect.value,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Something went wrong generating your listing.");
    }

    renderOutput(data, productTypeSelect.value);
  } catch (err) {
    generateError.textContent = err.message || "Something went wrong. Please try again.";
    generateError.hidden = false;
  } finally {
    updateGenerateButtonState();
    generateBtn.textContent = "Generate Listing";
  }
});

function renderOutput(listing, productType) {
  outputSection.hidden = false;

  outputTitle.textContent = listing.title || "";
  titleCount.textContent = `${(listing.title || "").length} / 140`;

  outputDescription.textContent = listing.description || "";

  lastTags = Array.isArray(listing.tags) ? listing.tags : [];
  outputTags.innerHTML = "";
  lastTags.forEach((tag) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `<span>${escapeHtml(tag)}</span><span class="tag-count">${tag.length}/20</span>`;
    outputTags.appendChild(chip);
  });

  outputCategory.textContent = listing.suggested_category || "";

  outputAttributes.innerHTML = "";
  const attributes = listing.suggested_attributes || {};
  const labels = {
    material: "Material",
    primary_color: "Primary color",
    who_its_for: "Who it's for",
    occasion: "Occasion",
    style: "Style",
  };
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = labels[key] || key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    outputAttributes.appendChild(dt);
    outputAttributes.appendChild(dd);
  });

  outputSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Copy buttons ---
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-copy[data-copy-target]");
  if (!btn) return;

  const target = btn.dataset.copyTarget;
  const textMap = {
    title: outputTitle.textContent,
    description: outputDescription.textContent,
    category: outputCategory.textContent,
  };
  copyToClipboard(textMap[target], btn);
});

copyAllTagsBtn.addEventListener("click", () => {
  copyToClipboard(lastTags.join(", "), copyAllTagsBtn);
});

async function copyToClipboard(text, btn) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const original = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => {
    btn.textContent = original;
  }, 1500);
}
