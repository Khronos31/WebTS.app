// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_USERLAND_POSIX_IPC_TEST_ACCESS_H
#define PX4_USERLAND_POSIX_IPC_TEST_ACCESS_H

#include <sys/types.h>

namespace px4::userland::ipc::posix {

using PosixIpcGetGroups = int (*)(int, gid_t*) noexcept;

// Test-only access to the ownership decision.  The explicit credentials and
// syscall callback keep tests independent of the process's real credentials.
class PosixIpcTestAccess final {
public:
    static bool ownership_allowed(uid_t owner_uid, gid_t owner_gid,
                                  uid_t effective_uid, gid_t effective_gid,
                                  bool group_access,
                                  PosixIpcGetGroups getgroups) noexcept;
};

}  // namespace px4::userland::ipc::posix

#endif  // PX4_USERLAND_POSIX_IPC_TEST_ACCESS_H
