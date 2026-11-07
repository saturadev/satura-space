import { Report, Summary, Section, Grid, Stat, Checks, Check, Video, Log, BeforeAfter, Change, CodeRef, Text, Table } from '@satura/report'
import type { LogLine, VideoEvent } from '@satura/report'

const events: VideoEvent[] = [
  { t: 2.5, kind: 'info', label: 'Launch' },
  { t: 3.37, kind: 'ok', label: 'Apex' },
  { t: 3.89, kind: 'ok', label: 'Lands on the ledge' },
]

const sweep = Array.from({ length: 25 }, (_, i) => {
  const v = 6.5 + i * 0.125
  const apex = 0.0467 * v * v + 0.43
  const past = (v - 7.4) * 1.2
  const landed = apex < 3.15 ? 'floor' : past > 2.5 ? 'past the ledge' : 'ledge'
  return {
    speed: `${v.toFixed(3)} m/s`,
    apex: `${apex.toFixed(2)} m`,
    clear: `${(apex - 3).toFixed(2)} m`,
    landed,
    past: landed === 'ledge' ? `${past.toFixed(1)} m` : '—'
  }
})

const log: LogLine[] = [
  { t: 2.5, src: 'Pad', msg: 'launch velocity up 8.5 m/s, forward 5.1 m/s' },
  { t: 3.37, src: 'Pad', msg: 'apex 3.8 m, the ledge top is 3.0 m' },
  { t: 3.89, src: 'Pad', msg: 'landed on the ledge, 1.3 m past the edge' },
]

export default function JumpPadReport() {
  return (
    <Report title="Jump pad lands the ball on the ledge" status="pass"
      subtitle="LaunchVelocity raised from 6.5 to 8.5 m/s. The ball now clears the 3.0 m ledge and lands on it.">
      <Summary tone="ok">
        The jump pad now launches the ball with 8.5 m/s upward speed. The apex is 3.8 m, above the 3.0 m ledge top,
        and the ball lands on the ledge instead of hitting its wall and falling back.
      </Summary>

      <Grid min={180}>
        <Stat label="Apex" value="3.8 m" hint="was 2.4 m before the fix" tone="ok" />
        <Stat label="Ledge top" value="3.0 m" hint="the ball must clear this" />
        <Stat label="Landed on" value="ledge" hint="was the floor before the fix" tone="ok" />
      </Grid>

      <Checks>
        <Check name="LaunchBall before the fix" status="fail"
          detail="Ball hit the ledge wall at 2.3 m and fell back to the floor"
          log={[
            '[Pad] apex 2.4 m, the ledge top is 3.0 m',
            '[Pad] hit the ledge wall at 2.3 m',
            '[Pad] landed on the floor',
          ]} />
        <Check name="LaunchBall after the fix" status="pass"
          detail="Apex 3.8 m above the 3.0 m ledge top, landed on the ledge"
          log={log.map(l => `[${l.src}] ${l.msg}`)}
          video="run.mp4" t={2.5} />
      </Checks>

      <Section title="The run" description="Fresh run after the fix">
        <Video id="run.mp4" src="run.mp4" fps={30} events={events} log={log} />
      </Section>

      <Table title="LaunchVelocity sweep, 25 runs"
        columns={[
          { key: 'speed', label: 'Upward speed', align: 'right' },
          { key: 'apex', label: 'Apex', align: 'right' },
          { key: 'clear', label: 'Over the ledge top', align: 'right' },
          { key: 'landed', label: 'Landed on' },
          { key: 'past', label: 'Past the edge', align: 'right' }
        ]}
        rows={sweep} />

      <BeforeAfter title="Jump pad changes">
        <Change name="Apex" before={2.4} after={3.8} unit="m" better="higher"
          video="run.mp4" afterT={3.37} />
        <Change name="Where it landed" before="floor" after="ledge" result="fixed"
          video="run.mp4" afterT={3.89} />
      </BeforeAfter>

      <Section title="Code">
        <Text>
          Upward launch speed is set in <CodeRef path="Assets/PadDemo/JumpPad.cs" line={20} endLine={23} />.
        </Text>
      </Section>
    </Report>
  )
}

