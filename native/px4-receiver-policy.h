// 受信機の割り当ての規則。**機種を問わない。**
//
// 受信機がどの波（地上波・衛星）を受けられるかだけを見て決める。能力は
// 上流の backend が答える（TunerServiceBackend::receiver_supports）。ここは
// 能力を関数で受け取るだけなので、backend も USB も無しに試せる
// （test/native/receiver-policy-test.cpp）。
//
//   視聴 … その波を受けられる空いた受信機のうち、最も若い番号。
//   走査 … その波を受けられる受信機から、視聴用の1本（最も若い番号）を
//          除いたもの。地上波と衛星の両方を受けられる受信機は、若い順に
//          地上波・衛星・地上波…と交互に分ける。両方の走査を同時に回しても
//          取り合わないためである。
//
// PX-Q3U4（0/1/4/5 が衛星、2/3/6/7 が地上波）では、視聴が地上波 2・衛星 0、
// 走査が地上波 3/6/7・衛星 1/4/5。PX-MLT5PE（0..4 のどれでも両方）では、
// 視聴が 0、地上波の走査が 1/3、衛星の走査が 2/4。

#ifndef WEBTS_PX4_RECEIVER_POLICY_H
#define WEBTS_PX4_RECEIVER_POLICY_H

#include <cstdint>

namespace webts {

enum class Wave : std::uint8_t { terrestrial = 0, satellite = 1 };
enum class ReceiverUse : std::uint8_t { viewing = 0, scan = 1 };

/** 受信機の能力。Supports は bool(std::uint8_t receiver, Wave wave) として呼べるもの。 */
template <typename Supports>
int reserved_for_viewing(std::uint8_t count, Wave wave, const Supports& supports) noexcept {
    for (std::uint8_t r = 0U; r < count; ++r) {
        if (supports(r, wave)) return r;
    }
    return -1;
}

/** その波の走査に使ってよい受信機か。 */
template <typename Supports>
bool scan_may_use(std::uint8_t count, std::uint8_t receiver, Wave wave,
                  const Supports& supports) noexcept {
    if (receiver >= count || !supports(receiver, wave)) return false;
    if (reserved_for_viewing(count, wave, supports) == receiver) return false;
    const Wave other = wave == Wave::terrestrial ? Wave::satellite : Wave::terrestrial;
    if (!supports(receiver, other)) return true;
    // 両方を受けられる受信機（どちらかの視聴用を除く）を若い順に並べ、
    // 地上波が偶数番目、衛星が奇数番目を取る。
    const int reserved_t = reserved_for_viewing(count, Wave::terrestrial, supports);
    const int reserved_s = reserved_for_viewing(count, Wave::satellite, supports);
    int shared_index = 0;
    for (std::uint8_t r = 0U; r < count; ++r) {
        if (!supports(r, Wave::terrestrial) || !supports(r, Wave::satellite)) continue;
        if (r == reserved_t || r == reserved_s) continue;
        if (r == receiver) return (shared_index % 2 == 0) == (wave == Wave::terrestrial);
        ++shared_index;
    }
    return false;
}

/**
 * 空いている受信機から1本選ぶ。claimed は bool(std::uint8_t receiver)。
 * 取れなければ -1。
 */
template <typename Supports, typename Claimed>
int choose_receiver(std::uint8_t count, Wave wave, ReceiverUse use, const Supports& supports,
                    const Claimed& claimed) noexcept {
    for (std::uint8_t r = 0U; r < count; ++r) {
        if (claimed(r) || !supports(r, wave)) continue;
        if (use == ReceiverUse::scan && !scan_may_use(count, r, wave, supports)) continue;
        return r;
    }
    return -1;
}

}  // namespace webts

#endif  // WEBTS_PX4_RECEIVER_POLICY_H
