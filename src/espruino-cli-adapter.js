import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeName, classifyDeviceFile } from './core.js';

const exec = promisify(execFile);
const MARKER = '__BANGLESYNC_RESULT_';
const safeError = text => String(text).replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, '[Bluetooth address redacted]').replace(/\b(?:[0-9A-F]{2}-){5}[0-9A-F]{2}\b/gi, '[Bluetooth address redacted]').replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}\b/g, '[identifier redacted]').slice(0, 1000);
const b64 = data => Buffer.from(data).toString('base64');
const sha256 = data => createHash('sha256').update(data).digest('hex');

export class EspruinoCliAdapter {
  constructor({ executable = null, timeoutMs = 15000, maxBufferBytes = 65536, spawnProcess = spawn, ownership = {}, applications = {}, baselinePaths = {}, knownFiles = [], inlineFiles = [] } = {}) {
    const bundledCli = fileURLToPath(new URL('../node_modules/espruino/bin/espruino-cli.js', import.meta.url));
    this.executable = executable && executable.toLowerCase().endsWith('.js') ? process.execPath : (executable || process.execPath);
    this.cliArguments = executable ? (executable.toLowerCase().endsWith('.js') ? [executable] : []) : [bundledCli];
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.executable)) throw new Error('On Windows, configure the EspruinoTools JavaScript CLI file rather than a .cmd/.bat shim.');
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1024 || maxBufferBytes > 4 * 1024 * 1024) throw new Error('REPL buffer limit must be between 1 KiB and 4 MiB.');
    if (!Array.isArray(knownFiles) || knownFiles.length > 10000) throw new Error('Known user-file catalog is invalid or exceeds the inventory limit.');
    this.timeoutMs = timeoutMs; this.maxBufferBytes = maxBufferBytes; this.spawnProcess = spawnProcess; this.ownership = ownership; this.applications = applications; this.baselinePaths = baselinePaths;
    const candidates = new Set([...knownFiles, ...Object.keys(ownership)]);
    this.knownFiles = [...candidates].filter(name => safeName(name) && classifyDeviceFile(name).classification !== 'protected-system').sort();
    this.inlineFiles = new Set(inlineFiles.filter(name => this.knownFiles.includes(name)));
    this.child = null; this.buffer = ''; this.waiters = []; this.closed = false; this.deviceId = null;
  }
  async discover() {
    try {
      const { stdout } = await exec(this.executable, [...this.cliArguments, '--list', '--scan-timeout', '10'], { timeout: this.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      return stdout.split(/\r?\n/).filter(line => /bangle/i.test(line)).map(line => {
        const mac = line.match(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i)?.[0];
        const name = line.replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/ig, '').replace(/\s+/g, ' ').trim();
        return { id: mac ?? null, name: name || 'Bangle.js device', transport: 'EspruinoTools subprocess' };
      });
    } catch (error) {
      const diagnostic = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      if (/No Ports Found/i.test(diagnostic)) throw new Error('EspruinoTools reported no selectable Bangle.js device. Make the watch discoverable, ensure Bluetooth is enabled, and disconnect it from other hosts before retrying. Device identifiers were not logged.');
      throw new Error(`EspruinoTools discovery failed (${safeError(error.code ?? error.message)}). Check the EspruinoTools CLI and Windows BLE permissions.`);
    }
  }
  async connect(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId.trim() || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(deviceId)) throw new Error('Select a valid discovered device before connecting.');
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await this._connectOnce(deviceId); }
      catch (error) {
        lastError = error;
        if (!this._isTransportFailure(error) || attempt === 3) throw error;
        await this.disconnect(); this.deviceId = deviceId;
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
    throw new Error(`Connection failed after 3 attempts: ${safeError(lastError?.message ?? 'transport unavailable')}`);
  }
  async _connectOnce(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error('Select a discovered device before connecting.');
    if (this.child) throw new Error('A device session is already active.');
    this.closed = false; this.deviceId = deviceId; this.lastDiagnostic = null; this.requestCount = 0; this.currentOperation = 'user API handshake';
    if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(deviceId)) throw new Error('Discovered device selector is invalid.');
    const child = this.spawnProcess(this.executable, [...this.cliArguments, '--quiet', '--port', deviceId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { this.buffer += text; if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBufferBytes) { this._rejectAll(new Error('REPL output exceeded the configured buffer limit.')); child.kill(); return; } this._flush(); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', () => { this.lastDiagnostic = 'additional transport diagnostics were suppressed for privacy'; });
    child.on('error', error => { this.closed = true; this._rejectAll(new Error(`EspruinoTools subprocess failed: ${safeError(error.message)}`)); });
    child.on('close', code => { this.closed = true; this.child = null; this._rejectAll(new Error(`EspruinoTools subprocess disconnected during ${this.currentOperation} after ${this.requestCount} REPL requests (exit ${code ?? 'unknown'}). ${this.lastDiagnostic ?? ''}`)); });
    try {
      const userApi = await this._request('({bangle:typeof Bangle})');
      if (!userApi || userApi.bangle === 'undefined') throw new Error('Selected device REPL did not expose the Bangle.js user API.');
      return { connected: true, userApi: 'Bangle.js', bangleApiType: userApi.bangle, transport: 'EspruinoTools subprocess' };
    } catch (error) { await this.disconnect(); throw error; }
  }
  _rejectAll(error) {
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
  _flush() {
    for (const waiter of [...this.waiters]) {
      let start = this.buffer.indexOf(waiter.marker), end = -1, value;
      while (start >= 0) {
        end = this.buffer.indexOf('\n', start);
        if (end < 0) break;
        try { value = JSON.parse(this.buffer.slice(start + waiter.marker.length, end).trim()); break; }
        catch { start = this.buffer.indexOf(waiter.marker, start + waiter.marker.length); }
      }
      if (start < 0 || end < 0) continue;
      this.buffer = this.buffer.slice(end + 1);
      this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer);
      if (value && value.__error) waiter.reject(new Error(safeError(value.__error)));
      else waiter.resolve(value);
    }
  }
  _request(expression, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.child || this.closed) return Promise.reject(new Error('No active EspruinoTools device session.'));
    this.requestCount++;
    const marker = `${MARKER}${randomUUID().replace(/-/g, '')}__`;
    const script = `try{var __bs=(${expression});print(${JSON.stringify(marker)}+JSON.stringify(__bs));}catch(e){print(${JSON.stringify(marker)}+JSON.stringify({__error:String(e)}));}`;
    return new Promise((resolve, reject) => {
      const waiter = { marker, resolve, reject, timer: setTimeout(() => { const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('Timed out waiting for a REPL response.')); }, timeoutMs) };
      this.waiters.push(waiter);
      try { this.child.stdin.write(`${script}\n`); } catch (error) { clearTimeout(waiter.timer); this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(new Error(safeError(error.message))); }
    });
  }
  async _ensureConnected() {
    if (this.child && !this.closed) return;
    await this._reconnect();
  }
  async info() {
    await this._ensureConnected();
    const userApi = await this._request('({bangle:typeof Bangle})');
    return { connected: true, userApi: userApi?.bangle === 'undefined' ? 'unavailable' : 'Bangle.js', bangleApiType: userApi?.bangle ?? 'unknown', transport: 'EspruinoTools subprocess' };
  }
  async launchApp(appId, { confirm = false } = {}) {
    if (!confirm) throw new Error('Launching an app requires explicit --confirm.');
    if (typeof appId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(appId)) throw new Error('Invalid app ID.');
    const name = `${appId}.app.js`;
    if (!this.knownFiles.includes(name) || !this.applications[name]?.includes(appId) || this.ownership[name] !== `app:${appId}`) throw new Error('Only explicitly BangleSync-owned, catalogued app files may be launched by this command.');
    await this._ensureConnected(); this.currentOperation = 'selected user-app launch';
    await this._request(`(function(){load(${JSON.stringify(name)});return true;})()`, { timeoutMs: 30000 });
    return { launched: appId, file: name, firmwareInspected: false };
  }
  async showClock() {
    await this._ensureConnected(); this.currentOperation = 'Bangle.showClock user API';
    await this._request('(function(){if(typeof Bangle.showClock!=="function")throw new Error("Bangle.showClock is unavailable");Bangle.showClock();return true;})()', { timeoutMs: 30000 });
    return { restored: 'current user clock', lowLevelStateInspected: false };
  }
  async inventory() {
    await this._ensureConnected();
    this.currentOperation = 'catalog-bounded user-file inventory';
    const present = [];
    for (let offset = 0; offset < this.knownFiles.length; offset += 32) {
      const batch = this.knownFiles.slice(offset, offset + 32); let found, lastError;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { found = await this._request(`(function(){var s=require("Storage"),n=${JSON.stringify(batch)},a=[];for(var i=0;i<n.length;i++){try{var p=s.read(n[i],0,1);if(p!==undefined){a.push({name:n[i],storageFile:false});continue;}var f=s.open(n[i],"r");if(f){var length=typeof f.getLength==="function"?f.getLength():0,first=f.read(1);if(length>0||(first!==undefined&&first!==""))a.push({name:n[i],storageFile:true});}}catch(e){}}return a;})()`); break; }
        catch (error) { lastError = error; if (!this._isTransportFailure(error) || attempt === 1) throw error; await this._reconnect(); }
      }
      if (found === undefined && lastError) throw lastError;
      if (!Array.isArray(found) || found.some(item => !item || !batch.includes(item.name) || typeof item.storageFile !== 'boolean')) throw new Error('Device returned an invalid catalog-bounded inventory response.');
      present.push(...found);
    }
    return present.map(item => {
      const owners = this.applications[item.name] ?? [], application = owners.length === 1 ? owners[0] : null;
      return { name: item.name, storageFile: item.storageFile, size: null, application, applicationCandidates: owners, owner: this.ownership[item.name] ?? null, baselinePath: (this.baselinePaths[item.name] ?? []).length === 1 ? this.baselinePaths[item.name][0] : null, ...classifyDeviceFile(item.name, { owned: new Set(Object.keys(this.ownership)), knownApplication: owners.length > 0, allowlistedConfiguration: ['setting.json', 'wid_settings.json'].includes(item.name) }) };
    });
  }
  _isTransportFailure(error) { return /disconnected|timed out|No active EspruinoTools|subprocess failed|broken pipe|download failed|could not reconnect|ENOENT/i.test(error?.message ?? ''); }
  async _reconnect() {
    const id = this.deviceId;
    if (!id) throw new Error('No previous device selection is available for reconnection.');
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this.disconnect(); this.deviceId = id;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      try { return await this._connectOnce(id); } catch (error) { lastError = error; this.deviceId = id; }
    }
    this.deviceId = null;
    throw new Error(`Automatic reconnect failed after 2 attempts: ${safeError(lastError?.message ?? 'transport unavailable')}`);
  }
  async _readViaRepl(name) {
    await this._ensureConnected();
    this.currentOperation = 'catalogued user-file REPL transfer';
    const first = await this._request(`(function(){var s=require("Storage"),n=${JSON.stringify(name)},p;try{p=s.read(n,0,16385);}catch(e){return {kind:"storagefile"};}if(p===undefined){try{var f=s.open(n,"r");if(f){global.__bangleSyncReader=f;return {kind:"storagefile"};}}catch(e){}return {kind:"missing"};}if(p.length>16384||typeof s.readArrayBuffer!=="function")return {kind:"chunked"};var b=s.readArrayBuffer(n);if(!b)return {kind:"chunked"};var u=new Uint8Array(b),a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",o="";for(var i=0;i<u.length;i+=3){var x=u[i],y=i+1<u.length?u[i+1]:0,z=i+2<u.length?u[i+2]:0;o+=a.charAt(x>>2)+a.charAt(((x&3)<<4)|(y>>4))+(i+1<u.length?a.charAt(((y&15)<<2)|(z>>6)):"=")+(i+2<u.length?a.charAt(z&63):"=");}return {kind:"inline",data:o};})()`, { timeoutMs: 90000 });
    if (first?.kind === 'missing') throw new Error('Catalogued user file was not present.');
    if (first?.kind === 'inline') { const bytes = Buffer.from(first.data, 'base64'); if (bytes.toString('base64') !== first.data) throw new Error('Binary readback was not canonical Base64.'); return bytes; }
    const storageFile = first?.kind === 'storagefile', chunks = []; let offset = 0, total = 0, sequence = 0, chunkSize = 2048;
    if (storageFile && !await this._request('(function(){return !!global.__bangleSyncReader;})()')) await this._request(`(function(){global.__bangleSyncReader=require("Storage").open(${JSON.stringify(name)},"r");return !!global.__bangleSyncReader;})()`);
    for (;;) {
      const part = storageFile
        ? await this._request(`(function(){var s=global.__bangleSyncReader.read(${chunkSize});if(s===undefined||s==="")return null;var a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",o="";for(var i=0;i<s.length;i+=3){var x=s.charCodeAt(i)&255,y=i+1<s.length?s.charCodeAt(i+1)&255:0,z=i+2<s.length?s.charCodeAt(i+2)&255:0;o+=a.charAt(x>>2)+a.charAt(((x&3)<<4)|(y>>4))+(i+1<s.length?a.charAt(((y&15)<<2)|(z>>6)):"=")+(i+2<s.length?a.charAt(z&63):"=");}return o;})()`, { timeoutMs: 60000 })
        : await this._request(`(function(){var s=require("Storage").read(${JSON.stringify(name)},${offset},${chunkSize});if(s===undefined)return null;var a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",o="";for(var i=0;i<s.length;i+=3){var x=s.charCodeAt(i)&255,y=i+1<s.length?s.charCodeAt(i+1)&255:0,z=i+2<s.length?s.charCodeAt(i+2)&255:0;o+=a.charAt(x>>2)+a.charAt(((x&3)<<4)|(y>>4))+(i+1<s.length?a.charAt(((y&15)<<2)|(z>>6)):"=")+(i+2<s.length?a.charAt(z&63):"=");}return o;})()`, { timeoutMs: 60000 });
      if (part === null || part === '') break;
      const bytes = Buffer.from(part, 'base64'); if (bytes.toString('base64') !== part) throw new Error('Binary chunk was not canonical Base64.');
      chunks.push(bytes); offset += bytes.length; total += bytes.length; sequence++;
      if (total > 32 * 1024 * 1024) throw new Error('Catalogued file exceeds the 32 MiB transfer limit.');
    }
    if (storageFile) await this._request('(function(){global.__bangleSyncReader=undefined;return true;})()');
    return Buffer.concat(chunks);
  }
  async _readOnce(name) {
    const deviceId = this.deviceId;
    if (!deviceId) throw new Error('No selected device is available for the file download.');
    const hadSession = Boolean(this.child);
    if (hadSession) { await this.disconnect(); this.deviceId = deviceId; }
    await new Promise(resolve => setTimeout(resolve, hadSession ? 1500 : 500));
    const directory = await mkdtemp(join(tmpdir(), 'bangle-sync-download-')), target = join(directory, name);
    try {
      this.currentOperation = 'EspruinoTools catalogued user-file download';
      let result;
      try { result = await exec(this.executable, [...this.cliArguments, '--port', deviceId, '--download', name], { cwd: directory, timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024 }); }
      catch (error) { throw new Error(`EspruinoTools download subprocess failed (${safeError(error.code ?? error.message)}).`); }
      const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (/Unable to connect|No Ports Found/i.test(diagnostic)) throw new Error('EspruinoTools could not reconnect to the selected Bangle device.');
      if (/Timed out receiving file/i.test(diagnostic)) throw new Error('EspruinoTools timed out downloading the catalogued user file.');
      let encodedText;
      try { encodedText = await readFile(target, 'utf8'); } catch (error) { throw new Error(`EspruinoTools completed without creating the catalogued file (${safeError(error.code ?? error.message)}).`); }
      if (encodedText.length > 32 * 1024 * 1024) throw new Error('Downloaded user file exceeds the 32 MiB transfer limit.');
      for (let i = 0; i < encodedText.length; i++) if (encodedText.charCodeAt(i) > 255) throw new Error('Download output is not a binary-string encoding.');
      return Buffer.from(encodedText, 'latin1');
    } catch (error) { throw new Error(`EspruinoTools download failed (${safeError(error.code ?? error.message)}).`); }
    finally { this.deviceId = deviceId; await rm(directory, { recursive: true, force: true }); }
  }
  async read(name, { storageFile = true, preferRepl = false } = {}) {
    if (!safeName(name) || !this.knownFiles.includes(name)) throw new Error('Reads are limited to safe, catalogued user files.');
    this.currentOperation = 'catalogued user-file read';
    if (this.child && !this.closed && (preferRepl || this.inlineFiles.has(name))) return this._readViaRepl(name);
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { return await this._readOnce(name); }
      catch (error) {
        lastError = error;
        if (!this._isTransportFailure(error) || attempt === 2) break;
        const previousId = this.deviceId; let candidates = [];
        try { candidates = await this.discover(); } catch {}
        if (candidates.length === 1) this.deviceId = candidates[0].id;
        else if (candidates.length > 1 && !candidates.some(device => device.id === previousId)) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    try { return await this._readViaRepl(name); }
    catch (error) { throw new Error(`Standalone and REPL reads failed; partial data was discarded. ${safeError(lastError?.message ?? error.message)}; ${safeError(error.message)}`); }
  }
  async write(name, data, { storageFile = true, owner, action, backupVerified = false, expectedSize, expectedSha256, expectedPreviousSha256, onState = () => {} } = {}) {
    let transferState = 'pending', stageWriteStarted = false, destinationWriteStarted = false;
    const report = state => { transferState = state; try { onState(state); } catch {} };
    if (!safeName(name) || !Buffer.isBuffer(data) || typeof owner !== 'string' || !/^(?:app|behaviour):[a-z0-9][a-z0-9_-]{0,39}$/.test(owner)) throw new Error('A safe Storage target, binary content, and explicit component owner are required.');
    if (!this.knownFiles.includes(name)) throw new Error('Write refused: target is outside the declared user-app/settings catalog.');
    const allowlistedConfiguration = ['setting.json', 'setting.js', 'wid_settings.json'].includes(name);
    const classification = classifyDeviceFile(name, { owned: new Set(Object.keys(this.ownership)), allowlistedConfiguration });
    if (classification.classification === 'protected-system') throw new Error('Write refused by the central protection policy for a protected-system file.');
    if (allowlistedConfiguration) throw new Error('Direct settings-file writes are disabled; per-key merge support is not implemented.');
    if (this.ownership[name] && this.ownership[name] !== owner) throw new Error('Write refused: target ownership does not match the desired component.');
    if (!['create', 'update'].includes(action)) throw new Error('Write refused: action must be an approved create or update.');
    if (action === 'update' && !backupVerified) throw new Error('Replacing an app file requires a verified pre-change backup.');
    if (this.ownership[name] && action !== 'update') throw new Error('BangleSync-owned files can only be updated with explicit ownership.');
    if (!this.ownership[name] && action !== 'create') throw new Error('An unowned target may only be created, never overwritten.');
    if (action === 'update' && !/^[a-f0-9]{64}$/.test(expectedPreviousSha256 ?? '')) throw new Error('Update requires the reviewed previous content hash.');
    const initiallyPresent = (await this.inventory()).some(file => file.name === name);
    if ((action === 'create' && initiallyPresent) || (action === 'update' && !initiallyPresent)) throw new Error('Write refused: target create/update state changed since planning.');
    if (data.length > 32 * 1024 * 1024) throw new Error('Payload exceeds the 32 MiB transfer limit.');
    const digest = sha256(data);
    if ((expectedSize !== undefined && expectedSize !== data.length) || (expectedSha256 !== undefined && expectedSha256 !== digest)) throw new Error('Payload failed its expected size or SHA-256 preflight check.');
    const makeChunkPlan = payload => {
      const encoded = b64(payload), plan = [];
      for (let encodedOffset = 0; encodedOffset < encoded.length; encodedOffset += 256) {
        const piece = encoded.slice(encodedOffset, encodedOffset + 256);
        if (piece.length % 4 !== 0 || Buffer.from(piece, 'base64').toString('base64') !== piece) throw new Error('Preflight rejected a non-canonical or misaligned chunk plan.');
        plan.push({ piece, offset: Math.floor(encodedOffset / 4) * 3 });
      }
      return plan;
    };
    const chunks = makeChunkPlan(data);
    await this._ensureConnected();
    const previous = action === 'update' ? await this.read(name, { storageFile, preferRepl: true }) : null;
    if (previous && sha256(previous) !== expectedPreviousSha256) throw new Error('Existing destination changed since review; no write was attempted.');
    const previousChunks = previous ? makeChunkPlan(previous) : [];
    const temporary = `bss-t-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const recovery = previous ? `bss-r-${randomUUID().replace(/-/g, '').slice(0, 20)}` : null;
    const internalNames = [temporary, recovery].filter(Boolean);
    this.knownFiles.push(...internalNames); for (const internalName of internalNames) this.inlineFiles.add(internalName);
    const writeChunks = async (target, payload, plan) => {
      if (payload.length === 0) {
        const written = await this._request(`(function(){return require("Storage").write(${JSON.stringify(target)},"",0,0)===true;})()`);
        if (written !== true) throw new Error(`Storage rejected empty-file write for ${target}.`);
      }
      for (const { piece, offset } of plan) {
        const length = offset === 0 ? payload.length : 'undefined';
        const decode = `var a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",s=${JSON.stringify(piece)},o="";for(var i=0;i<s.length;i+=4){var x=a.indexOf(s.charAt(i)),y=a.indexOf(s.charAt(i+1)),z=a.indexOf(s.charAt(i+2)),w=a.indexOf(s.charAt(i+3));o+=String.fromCharCode((x<<2)|(y>>4));if(s.charAt(i+2)!="=")o+=String.fromCharCode(((y&15)<<4)|(z>>2));if(s.charAt(i+3)!="=")o+=String.fromCharCode(((z&3)<<6)|w);}`;
        const written = await this._request(`(function(){${decode}return require("Storage").write(${JSON.stringify(target)},o,${offset},${length})===true;})()`);
        if (written !== true) throw new Error(`Storage rejected write at byte offset ${offset} for ${target}.`);
      }
    };
    try {
      const collisions = new Set((await this.inventory()).map(file => file.name));
      if (internalNames.some(internalName => collisions.has(internalName))) throw new Error('Unique staging or recovery path already exists; refusing to overwrite it.');
      if (previous) {
        const current = await this.read(name, { storageFile, preferRepl: true });
        if (current.length !== previous.length || sha256(current) !== expectedPreviousSha256) throw new Error('Existing destination changed during preflight; no write was attempted.');
      }
      report('staging'); stageWriteStarted = true;
      await writeChunks(temporary, data, chunks);
      report('staged');
      const staged = await this.read(temporary, { storageFile, preferRepl: true });
      if (staged.length !== data.length || sha256(staged) !== digest) throw new Error('Staged payload failed exact-length or SHA-256 verification.');
      report('verified');
      if (previous) {
        await writeChunks(recovery, previous, previousChunks);
        const saved = await this.read(recovery, { storageFile, preferRepl: true });
        if (saved.length !== previous.length || sha256(saved) !== expectedPreviousSha256) throw new Error(`Recovery copy failed verification; destination remains unchanged, recovery path ${recovery}.`);
      }
      destinationWriteStarted = true; report('committing');
      try {
        await writeChunks(name, data, chunks);
        const committed = await this.read(name, { storageFile, preferRepl: true });
        if (committed.length !== data.length || sha256(committed) !== digest) throw new Error('Destination read-back failed exact-length or SHA-256 verification.');
      } catch (commitError) {
        if (!previous) {
          commitError.transferState = 'partially-written';
          commitError.recoveryRequired = true;
          commitError.message += ` Staged payload remains at ${temporary}.`;
          throw commitError;
        }
        try {
          await writeChunks(name, previous, previousChunks);
          const restored = await this.read(name, { storageFile, preferRepl: true });
          if (restored.length !== previous.length || sha256(restored) !== expectedPreviousSha256) throw new Error('Restored destination did not verify.');
          commitError.transferState = 'failed';
          commitError.recoveryRequired = false;
          commitError.message += ' Previous verified destination was restored.';
          try {
            for (const internalName of internalNames) await this._request(`(function(){require("Storage").erase(${JSON.stringify(internalName)});return true;})()`);
            const leftovers = new Set((await this.inventory()).map(file => file.name));
            if (internalNames.some(internalName => leftovers.has(internalName))) throw new Error('temporary files remain');
          } catch { commitError.recoveryRequired = true; commitError.message += ` Temporary recovery files remain and may be removed later (${recovery ?? temporary}).`; }
        } catch (restoreError) {
          commitError.transferState = 'recovery-required';
          commitError.recoveryRequired = true;
          commitError.message += ` Recovery failed (${safeError(restoreError.message)}); verified previous bytes remain at ${recovery}.`;
        }
        throw commitError;
      }
      report('committed');
      for (const internalName of internalNames) await this._request(`(function(){require("Storage").erase(${JSON.stringify(internalName)});return true;})()`);
      const remaining = new Set((await this.inventory()).map(file => file.name));
      if (internalNames.some(internalName => remaining.has(internalName))) throw new Error('Destination committed and verified, but temporary recovery files could not be removed.');
    } catch (error) {
      let failure = error;
      if (this._isTransportFailure(error)) {
        try {
          await this._reconnect();
          if (previous && recovery && error.transferState === 'recovery-required') {
            await writeChunks(name, previous, previousChunks);
            const restored = await this.read(name, { storageFile, preferRepl: true });
            if (restored.length !== previous.length || sha256(restored) !== expectedPreviousSha256) throw new Error('Restored destination did not verify after reconnect.');
            error.transferState = 'failed'; error.recoveryRequired = false;
            error.message += ' Previous verified destination was restored after reconnect.';
          }
        } catch (recoveryError) {
          if (previous && recovery && error.transferState === 'recovery-required') error.message += ` Automatic recovery after reconnect failed (${safeError(recoveryError.message)}); recovery copy remains at ${recovery}.`;
        }
        failure = new Error(`Transfer interrupted; staging path ${temporary}${recovery ? ` and recovery path ${recovery}` : ''} may require recovery. ${safeError(error.message)}`);
        failure.transferState = error.transferState; failure.recoveryRequired = error.recoveryRequired;
      }
      const state = failure.transferState || (transferState === 'committed' ? 'committed' : (stageWriteStarted || destinationWriteStarted ? 'partially-written' : 'failed'));
      failure.transferState = state;
      if (failure.recoveryRequired === undefined) failure.recoveryRequired = stageWriteStarted && (state !== 'committed' || destinationWriteStarted);
      report(state);
      throw failure;
    } finally {
      this.knownFiles = this.knownFiles.filter(file => !internalNames.includes(file));
      for (const internalName of internalNames) this.inlineFiles.delete(internalName);
    }
  }
  async disconnect() {
    const child = this.child; this.child = null; this.closed = true; this._rejectAll(new Error('Device session closed.'));
    if (child) {
      await new Promise(resolve => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { if (!child.killed) child.kill(); setTimeout(finish, 500); }, 1000);
        child.once('close', finish);
        try { child.stdin.end(); } catch { finish(); }
      });
    }
    this.deviceId = null;
  }
}
