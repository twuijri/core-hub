/**
 * The devices module's reads and writes: the devices linked to a person (and, for an
 * admin, everyone's), and the hub's push senders.
 *
 * A device belongs to a person, not to a profile (`x-scope: global`), so these keys do not
 * carry the profile: switching profiles does not change which phones you own.
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import { useRealtime } from '../realtime/context.js';

export type Device = components['schemas']['Device'];
export type PushSender = components['schemas']['PushSender'];
export type PushConfig = components['schemas']['PushConfig'];

export const deviceKeys = {
  list: ['devices'] as const,
  senders: ['push-senders'] as const,
  config: ['push-config'] as const,
};

export function useDevices() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: deviceKeys.list,
    // `Page` is an `allOf`, so the generated type leaves `items` unknown; the schema says Device.
    queryFn: async () =>
      (await client.request('get', '/devices', { query: { limit: 200 } })).data as {
        items: Device[];
        next_cursor: string | null;
      },
    enabled: !!session,
  });
}

function useDevicesInvalidation() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
  };
}

export function useRenameDevice() {
  const { client } = useAuth();
  const invalidate = useDevicesInvalidation();
  return useMutation({
    mutationFn: async (input: { id: string; name: string }) =>
      (
        await client.request('patch', '/devices/{device_id}', {
          params: { device_id: input.id },
          body: { name: input.name },
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useUnlinkDevice() {
  const { client } = useAuth();
  const invalidate = useDevicesInvalidation();
  return useMutation({
    mutationFn: async (id: string) =>
      (await client.request('delete', '/devices/{device_id}', { params: { device_id: id } })).data,
    onSuccess: invalidate,
  });
}

export function useTestPush() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async (id: string) =>
      (
        await client.request('post', '/devices/{device_id}/push/test', {
          params: { device_id: id },
        })
      ).data,
  });
}

export function usePushConfig() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: deviceKeys.config,
    queryFn: async () => (await client.request('get', '/push/config')).data,
    enabled: !!session,
  });
}

export function usePushSenders(enabled: boolean) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: deviceKeys.senders,
    queryFn: async () => (await client.request('get', '/push/senders')).data,
    enabled: !!session && enabled,
  });
}

export function useTestNotice() {
  const { client } = useAuth();
  return useMutation({
    mutationFn: async () => (await client.request('post', '/notify/test-notice')).data,
  });
}

/**
 * The list other clients changed: a phone paired, renamed, unlinked, came online. Every
 * one of these is a user-level event on `/rt/devices`; the list is refetched rather than
 * patched, because the server already knows what the admin's list should hold.
 */
export function useDeviceStream(): void {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  useEffect(() => {
    if (!session) return;
    const connection = socket('devices');
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
    };
    const events = [
      'device.linked',
      'device.updated',
      'device.unlinked',
      'device.online',
      'device.offline',
    ];
    for (const event of events) connection.on(event, refresh);
    if (!connection.connected) connection.connect();
    return () => {
      for (const event of events) connection.off(event, refresh);
    };
  }, [socket, queryClient, session]);
}
