const isPlainObject = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const normalizeMeta = (meta) => (isPlainObject(meta) ? { ...meta } : {});

const normalizeFiles = (files) => {
  if (!isPlainObject(files)) return null;
  const next = {};
  Object.entries(files).forEach(([name, content]) => {
    if (typeof name !== 'string' || !name.trim()) return;
    next[name] = typeof content === 'string' ? content : String(content ?? '');
  });
  return next;
};

export const ensureWorkspace = (progress) => {
  const safeProgress = isPlainObject(progress) ? progress : {};
  const result = isPlainObject(safeProgress.result) ? safeProgress.result : {};

  let files = normalizeFiles(result.files);
  let activeFile =
    typeof result.active_file === 'string'
      ? result.active_file
      : (typeof result.activeFile === 'string' ? result.activeFile : null);

  const meta = normalizeMeta(result.meta);

  if (!files) {
    if (typeof result.html === 'string') {
      files = { 'index.html': result.html };
      activeFile = 'index.html';
    } else {
      files = { 'index.html': '' };
      activeFile = 'index.html';
    }
  }

  if (!Object.prototype.hasOwnProperty.call(files, 'index.html')) {
    files['index.html'] = '';
  }

  if (!activeFile || typeof activeFile !== 'string' || !Object.prototype.hasOwnProperty.call(files, activeFile)) {
    activeFile = 'index.html';
  }

  return {
    ...safeProgress,
    result: {
      ...result,
      files,
      active_file: activeFile,
      meta,
    },
  };
};

export const pickNextPageFilename = (existingFiles) => {
  const names = new Set(
    Array.isArray(existingFiles)
      ? existingFiles.filter((name) => typeof name === 'string')
      : (isPlainObject(existingFiles) ? Object.keys(existingFiles) : []),
  );

  let n = 2;
  // Never touch index.html
  while (names.has(`page-${n}.html`)) n += 1;
  return `page-${n}.html`;
};

