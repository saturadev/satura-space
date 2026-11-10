import { Report, Summary, Checks, Check, Videos, Video, BeforeAfter, Change, CodeRef, Text } from '@satura/report'

export default function HealthPackReport() {
  return (
    <Report title="Health pack: pickup on the run" status="pass" subtitle="Packs/RunPast(1): pack 8 m down the road, 1 m off the runner's line, runner holds W and D for 3.4 s">
      <Summary tone="ok">
        Before the fix the runner passed 0.95 m from the pack on the ground and did not take it. After the fix the runner takes it and health goes from 50% to 100%.
      </Summary>
      <Checks>
        <Check name="Before: pack missed" status="pass" detail="taken=false, health stayed 0.5. Ground distance 0.95 m, but 1.25 m from the body, over the 1.2 m reach" video="before" frame={188} />
        <Check name="After: pack taken" status="pass" detail="taken=true, health 0.5 to 1.0" video="after" frame={182} />
      </Checks>
      <Videos sync={false}>
        <Video id="before" src="health-pack-before.mp4" label="Before" fps={60} events={[
          { frame: 45, label: 'Pack dropped' },
          { frame: 75, label: 'Run' },
          { frame: 188, label: 'Closest pass, 0.95 m on the ground, not taken', kind: 'error' },
        ]} />
        <Video id="after" src="health-pack-after.mp4" label="After" fps={60} events={[
          { frame: 47, label: 'Pack dropped' },
          { frame: 77, label: 'Run' },
          { frame: 182, label: 'Taken, health 50% to 100%', kind: 'ok' },
        ]} />
      </Videos>
      <BeforeAfter title="Result of the run">
        <Change name="Pack taken" before="no" after="yes" better="higher" video="after" />
        <Change name="Runner health" before={0.5} after={1.0} better="higher" />
        <Change name="Closest ground pass" before={0.95} after={1.21} unit="m" />
        <Change name="Closest distance from body" before={1.25} after={1.41} unit="m" />
      </BeforeAfter>
      <Text>The pickup check is in HealthPack.cs:54, where the height difference is dropped so only the distance along the ground counts against reach.</Text>
      <CodeRef path="Assets/Rollmates/Scripts/HealthPack.cs" line={50} endLine={56} />
    </Report>
  )
}
