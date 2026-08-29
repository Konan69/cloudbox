export interface MachineIdentityMount {
  readonly hostPath: string;
  readonly guestPath: string;
  readonly readOnly: false;
}

export interface MachineIdentityManifest {
  readonly version: 1;
  readonly mounts: ReadonlyArray<MachineIdentityMount>;
}

export const machineIdentityManifestPath = (boxUser: string): string =>
  `/home/${boxUser}/.config/cloudbox/machine-identity.json`;

const mountRoot = (path: string): string => {
  const components = path.slice(2).split("/").filter((component) => component.length > 0);
  const componentCount = components[0] === ".config" && components.length > 1 ? 2 : 1;
  return components.slice(0, componentCount).join("/");
};

export const deriveMachineIdentityManifest = (
  paths: ReadonlyArray<string>,
  boxUser: string,
): MachineIdentityManifest => {
  const home = `/home/${boxUser}`;
  const roots = [...new Set(paths.map((path) => `${home}/${mountRoot(path)}`))].sort();
  return {
    version: 1,
    mounts: roots.map((path) => ({ hostPath: path, guestPath: path, readOnly: false })),
  };
};

export const renderMachineIdentityManifest = (manifest: MachineIdentityManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;
