tools.image = async (data, mime, quality, width, height) => {
  const bitmap = await createImageBitmap(new Blob([unb64(data)], { type: mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const w = width || bitmap.width;
  const h = height || bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: quality / 100 });
  return { data: b64(new Uint8Array(await out.arrayBuffer())), width: w, height: h, mime: out.type };
};
