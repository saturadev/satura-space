import { Report, Summary, Section, Text, Videos, Video, BeforeAfter, Change, CodeRef, Code } from '@satura/report'

export default function HealthPackReport() {
  return (
    <Report
      title="Health pack: taken in passing"
      subtitle="Packs/RunPast(1): pack dropped 8 m down the road, 1 m off the runner's line, runner holds W and D for 3.4 s"
      status="pass"
    >
      <Summary tone="ok">
        Before the fix the runner passed 0.95 m from the pack with a 1.2 m reach and did not take it, health stayed at 50%.
        After it the pack is taken in passing and health goes from 50% to 100%.
      </Summary>

      <Section title="Both runs">
        <Videos>
          <Video
            id="before"
            src="/Users/Shared/dev/projects/hollowmere/.sspace/videos/health-pack-before.mp4"
            label="Before"
            fps={60}
            events={[
              { frame: 47, label: 'Pack dropped', kind: 'info' },
              { frame: 77, label: 'Run', kind: 'info' },
              { frame: 191, label: 'Closest pass, 0.95 m on the ground, not taken', kind: 'error' },
            ]}
          />
          <Video
            id="after"
            src="/Users/Shared/dev/projects/hollowmere/.sspace/videos/health-pack-after.mp4"
            label="After"
            fps={60}
            events={[
              { frame: 46, label: 'Pack dropped', kind: 'info' },
              { frame: 76, label: 'Run', kind: 'info' },
              { frame: 181, label: 'Taken, health 50% to 100%', kind: 'ok' },
            ]}
          />
        </Videos>
      </Section>

      <BeforeAfter title="Result of Packs/RunPast(1)">
        <Change name="Pack taken" before="no" after="yes" video="after" afterT={3.02} />
        <Change name="Health after the run" before={50} after={100} unit="%" better="higher" />
        <Change name="Closest pass" before={0.95} after={1.21} unit="m" />
      </BeforeAfter>

      <Section title="The change">
        <Text>The ground-plane distance check in HealthPack.Within:</Text>
        <CodeRef path="Assets/Rollmates/Scripts/HealthPack.cs" line={54} />
        <Code lang="csharp" title="HealthPack.cs:54">{'d.y = 0f;'}</Code>
        <Text tone="muted" size="sm">
          Reach is 1.2 m (RunnerHealth.reach), the runner's body is 1.22 m before and 1.53 m after.
        </Text>
      </Section>
    </Report>
  )
}
