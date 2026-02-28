export type MidiNoteEvent = {
  midi: number;
  timeMs: number;
  durationMs: number;
};

type TempoPoint = {
  tick: number;
  usPerQuarter: number;
};

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, false);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function readVarLen(data: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let ptr = start;
  for (let i = 0; i < 4; i += 1) {
    const b = data[ptr];
    ptr += 1;
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return { value, next: ptr };
}

function tickToMs(tick: number, tempos: TempoPoint[], ticksPerQuarter: number): number {
  let ms = 0;
  let prevTick = 0;
  let currentTempo = tempos[0]?.usPerQuarter ?? 500000;
  for (let i = 1; i < tempos.length && tempos[i].tick <= tick; i += 1) {
    const point = tempos[i];
    const dt = point.tick - prevTick;
    ms += (dt * currentTempo) / ticksPerQuarter / 1000;
    prevTick = point.tick;
    currentTempo = point.usPerQuarter;
  }
  const tail = tick - prevTick;
  ms += (tail * currentTempo) / ticksPerQuarter / 1000;
  return ms;
}

export function parseMidi(arrayBuffer: ArrayBuffer): MidiNoteEvent[] {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  if (String.fromCharCode(...bytes.slice(0, 4)) !== "MThd") {
    throw new Error("Invalid MIDI header");
  }

  const headerLen = readU32(view, 4);
  const format = readU16(view, 8);
  const trackCount = readU16(view, 10);
  const division = readU16(view, 12);
  if ((division & 0x8000) !== 0) {
    throw new Error("SMPTE time division is not supported");
  }
  const ticksPerQuarter = division;

  let ptr = 8 + headerLen;
  const tempos: TempoPoint[] = [{ tick: 0, usPerQuarter: 500000 }];
  const rawNotes: Array<{ midi: number; startTick: number; endTick: number }> = [];

  for (let t = 0; t < trackCount; t += 1) {
    if (String.fromCharCode(...bytes.slice(ptr, ptr + 4)) !== "MTrk") {
      throw new Error("Invalid MIDI track header");
    }
    const trackLen = readU32(view, ptr + 4);
    ptr += 8;
    const trackEnd = ptr + trackLen;

    let tick = 0;
    let runningStatus = 0;
    const active = new Map<string, number[]>();

    while (ptr < trackEnd) {
      const dv = readVarLen(bytes, ptr);
      tick += dv.value;
      ptr = dv.next;

      let status = bytes[ptr];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        ptr += 1;
        runningStatus = status;
      }

      if (status === 0xff) {
        const metaType = bytes[ptr];
        ptr += 1;
        const lenDv = readVarLen(bytes, ptr);
        const metaLen = lenDv.value;
        ptr = lenDv.next;
        if (metaType === 0x51 && metaLen === 3) {
          const usPerQuarter = (bytes[ptr] << 16) | (bytes[ptr + 1] << 8) | bytes[ptr + 2];
          tempos.push({ tick, usPerQuarter });
        }
        ptr += metaLen;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const lenDv = readVarLen(bytes, ptr);
        ptr = lenDv.next + lenDv.value;
        continue;
      }

      const eventType = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = bytes[ptr];
      const data2 = bytes[ptr + 1];

      if (eventType === 0x80 || eventType === 0x90) {
        const midi = data1;
        const velocity = eventType === 0x90 ? data2 : 0;
        ptr += 2;
        const key = `${channel}:${midi}`;

        if (velocity > 0) {
          const list = active.get(key) ?? [];
          list.push(tick);
          active.set(key, list);
        } else {
          const list = active.get(key);
          if (list && list.length) {
            const startTick = list.shift() ?? tick;
            rawNotes.push({ midi, startTick, endTick: tick });
          }
        }
      } else if (eventType === 0xa0 || eventType === 0xb0 || eventType === 0xe0) {
        ptr += 2;
      } else if (eventType === 0xc0 || eventType === 0xd0) {
        ptr += 1;
      } else {
        break;
      }
    }

    ptr = trackEnd;
  }

  tempos.sort((a, b) => a.tick - b.tick);

  const notes = rawNotes
    .map((n) => {
      const start = tickToMs(n.startTick, tempos, ticksPerQuarter);
      const end = tickToMs(n.endTick, tempos, ticksPerQuarter);
      return {
        midi: n.midi,
        timeMs: Math.max(0, start),
        durationMs: Math.max(0, end - start),
      };
    })
    .sort((a, b) => a.timeMs - b.timeMs);

  if (format !== 0 && format !== 1) {
    return notes;
  }
  return notes;
}
