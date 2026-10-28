### Fixed

- On Windows, an update no longer stops with "Failed to uninstall old application files. Please try
  running the installer again.: 2" when a process still holds a file of the earlier version. The
  installer now stops each process that holds a file in the OpenBot folder before it removes the
  earlier version. It does not stop services or Explorer. It writes the processes that it found to
  `%APPDATA%\OpenBot\logs\update\installer.log`. When the update still fails, OpenBot opens again
  in the earlier version. Before, OpenBot stayed closed and looked as if it did not start.
