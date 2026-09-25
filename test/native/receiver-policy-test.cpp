// 受信機の割り当て（native/px4-receiver-policy.h）の試験。
//
// 機種の能力表だけで決まる純粋な規則なので、USB も backend も使わない。
// 能力表は上流の backend の receiver_supports と同じものを書く。
//   PX-Q3U4 … TunerServiceBackend の既定（0/1/4/5 が衛星、2/3/6/7 が地上波）
//   PX-MLT5PE / DTV02A-5TS-P … Mlt5PeTunerBackend（0..4 のどれでも両方）
//   PX-W3U4 … 上流 px4d の W3U4TunerBackend（0/1 が衛星、2/3 が地上波）
// **実機では確かめられない組み合わせ**（新機種で地上波と衛星の走査を
// 同時に回す、全部埋まっている、など）をここで確かめる。

#include "px4-receiver-policy.h"

#include <array>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace {

using webts::ReceiverUse;
using webts::Wave;

int failures = 0;

void expect(bool condition, const char* what) {
    if (!condition) {
        std::printf("FAIL: %s\n", what);
        ++failures;
    }
}

struct Model final {
    const char* name;
    std::uint8_t count;
    bool (*supports)(std::uint8_t, Wave);
};

bool q3u4(std::uint8_t r, Wave w) {
    const bool satellite = r == 0U || r == 1U || r == 4U || r == 5U;
    return r < 8U && (w == Wave::satellite) == satellite;
}

bool mlt5pe(std::uint8_t r, Wave) {
    return r < 5U;
}

// PX-W3U4 … 上流 px4d の W3U4TunerBackend（0/1 が衛星、2/3 が地上波）。
bool w3u4(std::uint8_t r, Wave w) {
    return r < 4U && (w == Wave::satellite) == (r < 2U);
}

/** 視聴を1本取ったあと、走査の作業者が4人ずつ取っていったときの割り当て。 */
struct Plan final {
    int viewing = -1;
    std::vector<int> scan;
};

Plan plan(const Model& model, Wave wave, std::array<bool, 8>& claimed) {
    const auto supports = [&model](std::uint8_t r, Wave w) { return model.supports(r, w); };
    const auto taken = [&claimed](std::uint8_t r) { return claimed[r]; };
    Plan result;
    for (int worker = 0; worker < 4; ++worker) {
        const int r = webts::choose_receiver(model.count, wave, ReceiverUse::scan, supports, taken);
        if (r < 0) break;
        claimed[static_cast<std::size_t>(r)] = true;
        result.scan.push_back(r);
    }
    result.viewing = webts::choose_receiver(model.count, wave, ReceiverUse::viewing, supports, taken);
    return result;
}

bool same(const std::vector<int>& actual, std::initializer_list<int> expected) {
    return actual == std::vector<int>(expected);
}

void test_q3u4() {
    const Model model{"PX-Q3U4", 8U, &q3u4};
    std::array<bool, 8> claimed{};
    // これまで JS に書いていた割り当てと同じになること。
    const Plan terrestrial = plan(model, Wave::terrestrial, claimed);
    expect(same(terrestrial.scan, {3, 6, 7}), "Q3U4: 地上波の走査は 3/6/7");
    expect(terrestrial.viewing == 2, "Q3U4: 地上波の視聴は 2（走査が空けている）");
    const Plan satellite = plan(model, Wave::satellite, claimed);
    expect(same(satellite.scan, {1, 4, 5}), "Q3U4: 衛星の走査は 1/4/5");
    expect(satellite.viewing == 0, "Q3U4: 衛星の視聴は 0");
}

void test_w3u4() {
    const Model model{"PX-W3U4", 4U, &w3u4};
    std::array<bool, 8> claimed{};
    // 各波2本のうち1本を視聴用に空け、1本を走査に回す。
    const Plan terrestrial = plan(model, Wave::terrestrial, claimed);
    expect(same(terrestrial.scan, {3}), "W3U4: 地上波の走査は 3");
    expect(terrestrial.viewing == 2, "W3U4: 地上波の視聴は 2");
    const Plan satellite = plan(model, Wave::satellite, claimed);
    expect(same(satellite.scan, {1}), "W3U4: 衛星の走査は 1");
    expect(satellite.viewing == 0, "W3U4: 衛星の視聴は 0");
}

void test_mlt5pe_both_scans() {
    const Model model{"PX-MLT5PE", 5U, &mlt5pe};
    std::array<bool, 8> claimed{};
    // 地上波と衛星の走査を同時に回しても取り合わない。
    const Plan terrestrial = plan(model, Wave::terrestrial, claimed);
    expect(same(terrestrial.scan, {1, 3}), "MLT5PE: 地上波の走査は 1/3");
    const Plan satellite = plan(model, Wave::satellite, claimed);
    expect(same(satellite.scan, {2, 4}), "MLT5PE: 衛星の走査は 2/4");
    expect(terrestrial.viewing == 0 && satellite.viewing == 0,
           "MLT5PE: 視聴はどちらの波でも 0");
}

void test_mlt5pe_satellite_first() {
    const Model model{"PX-MLT5PE", 5U, &mlt5pe};
    std::array<bool, 8> claimed{};
    // 始める順が逆でも同じ分け方になる。
    const Plan satellite = plan(model, Wave::satellite, claimed);
    const Plan terrestrial = plan(model, Wave::terrestrial, claimed);
    expect(same(satellite.scan, {2, 4}), "MLT5PE: 衛星が先でも 2/4");
    expect(same(terrestrial.scan, {1, 3}), "MLT5PE: 地上波が後でも 1/3");
}

void test_viewing_takes_reserved_first() {
    const Model model{"PX-MLT5PE", 5U, &mlt5pe};
    const auto supports = [&model](std::uint8_t r, Wave w) { return model.supports(r, w); };
    std::array<bool, 8> claimed{};
    const auto taken = [&claimed](std::uint8_t r) { return claimed[r]; };
    // 走査が何も取っていなければ、視聴は視聴用の 0。
    expect(webts::choose_receiver(5U, Wave::satellite, ReceiverUse::viewing, supports, taken) == 0,
           "MLT5PE: 空いていれば視聴は 0");
    // 0 が埋まっていれば、視聴は次に若い空きを使う（走査の分け方には縛られない）。
    claimed[0] = true;
    expect(webts::choose_receiver(5U, Wave::satellite, ReceiverUse::viewing, supports, taken) == 1,
           "MLT5PE: 0 が埋まっていれば視聴は 1");
    // 走査は視聴用の 0 に触れない。
    claimed = {};
    expect(!webts::scan_may_use(5U, 0U, Wave::terrestrial, supports),
           "MLT5PE: 走査は 0 を使わない");
}

void test_full() {
    const Model model{"PX-Q3U4", 8U, &q3u4};
    const auto supports = [&model](std::uint8_t r, Wave w) { return model.supports(r, w); };
    std::array<bool, 8> claimed{};
    claimed.fill(true);
    const auto taken = [&claimed](std::uint8_t r) { return claimed[r]; };
    expect(webts::choose_receiver(8U, Wave::terrestrial, ReceiverUse::viewing, supports, taken) < 0,
           "埋まっていれば取れない");
    expect(!webts::scan_may_use(8U, 9U, Wave::terrestrial, supports), "範囲外は使わない");
    expect(!webts::scan_may_use(8U, 0U, Wave::terrestrial, supports),
           "Q3U4: 衛星の受信機は地上波の走査に使わない");
}

}  // namespace

int main() {
    test_q3u4();
    test_w3u4();
    test_mlt5pe_both_scans();
    test_mlt5pe_satellite_first();
    test_viewing_takes_reserved_first();
    test_full();
    if (failures == 0) std::printf("receiver policy: all passed\n");
    return failures == 0 ? 0 : 1;
}
