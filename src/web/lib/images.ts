export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif';

/** Загружает картинку и возвращает адрес для markdown: `/img/<id>.<ext>`. */
export async function uploadImage(file: File): Promise<string> {
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return ((await res.json()) as { path: string }).path;
}

export function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
}

/** Подпись из имени файла; у скриншота из буфера имя безликое — `image.png`. */
export function imageAlt(file: File): string {
  const name = file.name.replace(/\.[^.]+$/, '');
  return name === 'image' ? '' : name.replace(/[[\]]/g, '');
}
