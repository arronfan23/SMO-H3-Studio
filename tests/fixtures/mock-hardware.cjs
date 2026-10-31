const childProcess = require('node:child_process');

const originalExecFile = childProcess.execFile;
const GIB = 1024 ** 3;

function isCommand(command, name) {
  const normalized = String(command).toLowerCase().replaceAll('/', '\\');
  return normalized === name || normalized.endsWith(`\\${name}`);
}

function isHardwarePowerShell(args) {
  const commandLine = args.join(' ');
  return (
    commandLine.includes('Win32_OperatingSystem') &&
    commandLine.includes('TotalPhysicalMemory') &&
    commandLine.includes('FreeDiskBytes')
  );
}

childProcess.execFile = function mockHardwareExecFile(command, args, options, callback) {
  const actualCallback = typeof options === 'function' ? options : callback;
  const actualArgs = Array.isArray(args) ? args : [];
  let stdout;

  if (isCommand(command, 'nvidia-smi') || isCommand(command, 'nvidia-smi.exe')) {
    stdout = 'NVIDIA GeForce RTX 5080, 16384 MiB, 576.88, 12.0\n';
  } else if (
    (isCommand(command, 'powershell.exe') || isCommand(command, 'powershell')) &&
    isHardwarePowerShell(actualArgs)
  ) {
    stdout = JSON.stringify({
      WindowsVersion: 'Mock Windows 11',
      TotalMemoryBytes: 64 * GIB,
      FreeDiskBytes: 512 * GIB,
    });
  } else {
    return originalExecFile.call(this, command, args, options, callback);
  }

  process.nextTick(() => actualCallback(null, stdout, ''));
  return { pid: 0, kill() {} };
};
