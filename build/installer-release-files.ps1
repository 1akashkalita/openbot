# The OpenBot installer runs this before it removes the earlier version (`build/installer.nsh`).
# The earlier uninstaller moves each file out of the installation folder, and it stops the update
# with "Failed to uninstall old application files" when a process still holds one. Its own check
# stops only the processes that run from the folder. This asks the Windows Restart Manager for
# every process that holds a file there, stops it and waits for it to exit. The Restart Manager
# does not stop services, Explorer or critical processes: they are only recorded. The log has the
# process ids and names, no paths, because a path holds the user name.
param(
  [Parameter(Mandatory = $true)] [string] $InstallDir,
  [Parameter(Mandatory = $true)] [string] $LogFile
)

$ErrorActionPreference = 'Stop'

$restartManager = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class OpenBotFileHolder {
  public int Id;
  public string Name;
  public int Type;
}

public static class OpenBotRestartManager {
  const int ErrorMoreData = 234;
  const int RmService = 3;
  const int RmExplorer = 4;
  const int RmCritical = 1000;

  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);

  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
    uint nApplications, IntPtr rgApplications, uint nServices, string[] rgsServiceNames);

  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
    [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

  public static bool CanStop(int type) {
    return type != RmService && type != RmExplorer && type != RmCritical;
  }

  public static OpenBotFileHolder[] Holders(string[] files) {
    uint session;
    int result = RmStartSession(out session, 0, new StringBuilder(64));
    if (result != 0) throw new System.ComponentModel.Win32Exception(result);
    try {
      // One call for thousands of paths is valid, but a few smaller calls keep each one short.
      for (int start = 0; start < files.Length; start += 500) {
        string[] part = new string[Math.Min(500, files.Length - start)];
        Array.Copy(files, start, part, 0, part.Length);
        result = RmRegisterResources(session, (uint)part.Length, part, 0, IntPtr.Zero, 0, null);
        if (result != 0) throw new System.ComponentModel.Win32Exception(result);
      }
      RM_PROCESS_INFO[] found = new RM_PROCESS_INFO[0];
      uint count = 0;
      uint needed;
      uint reasons = 0;
      // The list can grow between the size query and the read, so read again until it fits.
      while ((result = RmGetList(session, out needed, ref count, found, ref reasons)) == ErrorMoreData) {
        found = new RM_PROCESS_INFO[needed];
        count = needed;
      }
      if (result != 0) throw new System.ComponentModel.Win32Exception(result);
      List<OpenBotFileHolder> holders = new List<OpenBotFileHolder>();
      for (int index = 0; index < count; index++) {
        OpenBotFileHolder holder = new OpenBotFileHolder();
        holder.Id = found[index].Process.dwProcessId;
        holder.Name = found[index].strAppName;
        holder.Type = found[index].ApplicationType;
        holders.Add(holder);
      }
      return holders.ToArray();
    } finally {
      RmEndSession(session);
    }
  }
}
'@

function Write-InstallerLog([string] $Line) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null
  Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "$([DateTime]::UtcNow.ToString('o')) $Line"
}

try {
  # Windows PowerShell 5.1 compiles this with C# 5. Constrained Language Mode refuses it.
  Add-Type -TypeDefinition $restartManager
  $files = @(Get-ChildItem -LiteralPath $InstallDir -File -Recurse -Force -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName })
  if ($files.Count -eq 0) { exit 0 }
  # An uninstaller that runs from the folder holds its own file. It started this script.
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
  $holders = @([OpenBotRestartManager]::Holders($files) | Where-Object { $_.Id -ne $PID -and $_.Id -ne $parent })
  if ($holders.Count -eq 0) { exit 0 }
  $stopped = @()
  foreach ($holder in $holders) {
    $action = 'kept'
    if ([OpenBotRestartManager]::CanStop($holder.Type)) {
      Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue
      $stopped += $holder.Id
      $action = 'stopped'
    }
    Write-InstallerLog "$action process $($holder.Id) '$($holder.Name)' type $($holder.Type) that held a file of the earlier version"
  }
  # A stopped process keeps its files until it exits.
  if ($stopped.Count -gt 0) { Wait-Process -Id $stopped -Timeout 10 -ErrorAction SilentlyContinue }
} catch {
  Write-InstallerLog "could not release the files of the earlier version: $($_.Exception.Message)"
}
exit 0
