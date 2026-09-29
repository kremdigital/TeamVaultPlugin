/**
 * A scenario's setting: a project of its own on the stand, and the devices
 * syncing it, connected and settled.
 */
import { LiveClient, type LiveClientOptions } from './live-client';
import { Stand, type StandProject } from './stand';

export interface DeviceSpec {
  /** Also the device's client id, unless `clientId` is given. */
  name: string;
  /** Whose API key the device syncs with: an index into the project's members. */
  member: number;
  clientId?: string;
  queueRetryMs?: LiveClientOptions['queueRetryMs'];
}

export interface Team {
  stand: Stand;
  project: StandProject;
  projectId: string;
  devices: LiveClient[];
  /** Stop every device and its network. */
  close(): Promise<void>;
}

/** A new project with `members` users, and `devices` connected to it. */
export async function openTeam(devices: readonly DeviceSpec[], members = 2): Promise<Team> {
  const stand = Stand.fromEnv();
  const project = await stand.newProject(members);
  const opened: LiveClient[] = [];
  const team: Team = {
    stand,
    project,
    projectId: project.projectId,
    devices: opened,
    async close() {
      await Promise.allSettled(opened.map((d) => d.close()));
    },
  };
  try {
    for (const spec of devices) {
      const member = project.members[spec.member];
      if (!member) throw new Error(`no member ${spec.member}`);
      opened.push(
        await LiveClient.open(spec.name, {
          stand,
          projectId: project.projectId,
          apiKey: member.apiKey,
          clientId: spec.clientId ?? `device-${spec.name}`,
          ...(spec.queueRetryMs ? { queueRetryMs: spec.queueRetryMs } : {}),
        }),
      );
    }
    for (const device of opened) await device.start();
    for (const device of opened) await device.settled();
  } catch (err) {
    await team.close();
    throw err;
  }
  return team;
}
