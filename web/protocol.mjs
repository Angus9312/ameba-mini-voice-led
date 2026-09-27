export function normalizePhrase(text) {
  return text.trim().replace(/\s+/gu, '').replace(/[。！？!?，,.、]+$/gu, '')
    .replaceAll('边', '邊').replaceAll('开', '開').replaceAll('灯', '燈')
    .replaceAll('闪', '閃').replaceAll('烁', '爍').replaceAll('断', '斷')
    .replaceAll('讯', '訊').replaceAll('关', '關');
}
const commands = new Map([
  ['左邊開燈', 'BLUE_ON'], ['右邊開燈', 'GREEN_ON'],
  ['左邊關燈', 'BLUE_OFF'], ['右邊關燈', 'GREEN_OFF'],
  ['左邊閃爍三次', 'BLUE_BLINK3'], ['右邊閃爍三次', 'GREEN_BLINK3'],
  ['左邊閃爍3次', 'BLUE_BLINK3'], ['右邊閃爍3次', 'GREEN_BLINK3'],
  ['通訊中斷', 'STOP'],
]);
export function phraseCommand(text) { return commands.get(normalizePhrase(text)) ?? null; }
export function parseBoardLine(line) {
  // 板子開機日誌可能與 JSON 共用一行，從第一個 { 起解析。
  const start = line.indexOf('{');
  if (start < 0) return null;
  try {
    const value = JSON.parse(line.slice(start));
    if (value.v !== 3 || !Number.isSafeInteger(value.id) || value.id < 0 ||
      !['ack','error','state','done','ready','stopped'].includes(value.event) ||
      typeof value.command !== 'string' || typeof value.error !== 'string' ||
      ['blue','green','blueBlinking','greenBlinking'].some(key => typeof value[key] !== 'boolean')) return null;
    return value;
  } catch { return null; }
}
export function makeWav(chunks, inputRate) {
  const length = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const input = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const rate = 16000;
  const count = Math.floor(length * rate / inputRate);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const str = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset+i,c.charCodeAt(0)));
  str(0,'RIFF'); view.setUint32(4,36+count*2,true); str(8,'WAVE'); str(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,rate,true); view.setUint32(28,rate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  str(36,'data'); view.setUint32(40,count*2,true);
  for(let i=0;i<count;i++) {
    const start=Math.floor(i*inputRate/rate), end=Math.max(start+1,Math.floor((i+1)*inputRate/rate));
    let total=0; for(let j=start;j<Math.min(end,length);j++) total+=input[j];
    const value=Math.max(-1,Math.min(1,total/(end-start)));
    view.setInt16(44+i*2,value*(value<0?32768:32767),true);
  }
  return new Blob([buffer], {type:'audio/wav'});
}
