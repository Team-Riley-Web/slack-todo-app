'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { currentUser } from '@/user';
import {
  setChannelMapping, removeChannelMapping, removeSpace,
} from '@/operations/settings';

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

/**
 * Deleting a Space is destructive, so it is a POST from its own form with a
 * confirm on the button -- never a link, which a crawler or a stray middle
 * click could follow.
 */
export async function removeSpaceFormVoid(formData: FormData): Promise<void> {
  // Through guard(), like every other mutation here: deleting a Space must not
  // be the one action that skips the signed-in check.
  const db = await guard();
  if (!db) {
    redirect('/spaces?error=' + encodeURIComponent('You are not signed in.'));
  }
  const spaceId = String(formData.get('spaceId') ?? '');
  const result = await removeSpace(db, spaceId);
  revalidatePath('/spaces');
  revalidatePath('/settings');
  revalidatePath('/');
  if (!result.ok) {
    redirect(`/spaces?error=${encodeURIComponent(result.error)}`);
  }
  redirect('/spaces');
}
