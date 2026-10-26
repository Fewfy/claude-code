import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { Select } from '../../components/CustomSelect/select.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import {
  applyKeyProfile,
  discoverModels,
  inferWireApi,
  loadKeyProfiles,
  saveKeyProfiles,
  type KeyProfile,
  type KeyProfilesFile,
} from '../../utils/keyProfiles.js';

function summarize(name: string, profile: KeyProfile, active?: string): string {
  const marker = active === name ? '● ' : '  ';
  const models = profile.models?.length ? profile.models.join(', ') : '(no models discovered)';
  const wire = profile.wireApi ?? inferWireApi(profile.baseUrl);
  return `${marker}${name}  [${wire}]  ${models}`;
}

function KeyPicker({ file, onDone }: { file: KeyProfilesFile; onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const names = Object.keys(file.profiles);
  if (names.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No key profiles registered. Use `/keys add &lt;name&gt; &lt;apiKey&gt; [baseUrl]` to add one.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold>
          Select API key
        </Text>
        <Text dimColor>Arrow keys to navigate, Enter to select, Esc to cancel.</Text>
      </Box>
      <Select
        defaultValue={file.active ?? names[0]!}
        options={names.map(name => ({
          label: (
            <Text>
              {file.active === name ? '● ' : '  '}
              {name} <Text dimColor>({file.profiles[name]?.models?.length ?? 0} models)</Text>
            </Text>
          ),
          value: name,
        }))}
        onChange={name => {
          applyKeyProfile(name, file.profiles[name]!, file);
          onDone(`Switched to key profile: ${name}`, { display: 'system' });
        }}
        onCancel={() => onDone('Key selection cancelled.', { display: 'system' })}
        visibleOptionCount={Math.min(names.length, 8)}
      />
    </Box>
  );
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const file = loadKeyProfiles();
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0]?.toLowerCase();

  if (!sub) {
    return <KeyPicker file={file} onDone={onDone} />;
  }

  if (sub === 'list' || sub === 'ls') {
    const names = Object.keys(file.profiles);
    if (names.length === 0) {
      onDone('No key profiles registered.', { display: 'system' });
      return null;
    }
    onDone(['Key profiles:', ...names.map(name => summarize(name, file.profiles[name]!, file.active))].join('\n'), {
      display: 'system',
    });
    return null;
  }

  if (sub === 'show') {
    const active = file.active;
    if (!active || !file.profiles[active]) {
      onDone('No active key profile.', { display: 'system' });
      return null;
    }
    onDone(summarize(active, file.profiles[active]!, active), {
      display: 'system',
    });
    return null;
  }

  if (sub === 'use' || sub === 'switch') {
    const name = tokens[1];
    const profile = name ? file.profiles[name] : undefined;
    if (!name || !profile) {
      onDone(`Unknown profile: ${name ?? ''}. Use /keys list.`, {
        display: 'system',
      });
      return null;
    }
    applyKeyProfile(name, profile, file);
    onDone(`Switched to key profile: ${name}`, { display: 'system' });
    return null;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const name = tokens[1];
    if (!name || !file.profiles[name]) {
      onDone(`Unknown profile: ${name ?? ''}.`, { display: 'system' });
      return null;
    }
    delete file.profiles[name];
    if (file.active === name) file.active = undefined;
    saveKeyProfiles(file);
    onDone(`Removed key profile: ${name}`, { display: 'system' });
    return null;
  }

  if (sub === 'add') {
    const [, name, apiKey, baseUrlArg, wireArg] = tokens;
    if (!name || !apiKey) {
      onDone('Usage: /keys add <name> <apiKey> [baseUrl] [chat|responses]', {
        display: 'system',
      });
      return null;
    }
    const baseUrl = baseUrlArg ?? 'https://api.deepseek.com/v1';
    const wireApi = wireArg === 'responses' || wireArg === 'chat' ? wireArg : inferWireApi(baseUrl);
    const models = await discoverModels(baseUrl, apiKey);
    const profile: KeyProfile = { apiKey, baseUrl, wireApi, models };
    file.profiles[name] = profile;
    applyKeyProfile(name, profile, file);
    onDone(
      `Added and switched to key profile: ${name}\n` +
        `baseUrl: ${baseUrl}\n` +
        `wireApi: ${wireApi}\n` +
        `models: ${models.length > 0 ? models.join(', ') : '(none discovered — check baseUrl/key)'}`,
      { display: 'system' },
    );
    return null;
  }

  onDone(
    'Usage:\n' +
      '/keys                               select a profile\n' +
      '/keys list                          list profiles\n' +
      '/keys add <name> <key> [baseUrl] [chat|responses]\n' +
      '/keys use <name>                    switch profile\n' +
      '/keys remove <name>                 delete profile\n' +
      '/keys show                          show active profile',
    { display: 'system' },
  );
  return null;
}
