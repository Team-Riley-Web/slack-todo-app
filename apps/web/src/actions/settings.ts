'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { currentUser } from '@/user';
import { setChannelMapping, removeChannelMapping } from '@/operations/settings';

async function guard() {
  const user = await currentUser();
  if (!user) return null;
  return getDb();
}

export async function setChannelMappingFormVoid(formData: FormData): Promise<void> {
  const db = await guard();
  if (!db) redirect('/signin');

  const result = await setChannelMapping(
    db,
    String(formData.get('channelId') ?? ''),
    String(formData.get('channelName') ?? '') || null,
    String(formData.get('spaceName') ?? '')
  );
  revalidatePath('/settings');
  if (!result.ok) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}

export async function removeChannelMappingFormVoid(formData: FormData): Promise<void> {
  const db = await guard();
  if (!db) redirect('/signin');

  const result = await removeChannelMapping(db, String(formData.get('channelId') ?? ''));
  revalidatePath('/settings');
  if (!result.ok) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}
