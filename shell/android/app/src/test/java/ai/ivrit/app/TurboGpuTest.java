package ai.ivrit.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TurboGpuTest {
    private static TurboGpu.Verdict verdict(String state) {
        TurboGpu.Verdict v = new TurboGpu.Verdict("build q8_0");
        v.state = state;
        return v;
    }

    @Test
    public void automaticUsesTheGpuOnlyWhenFaster() {
        assertTrue(TurboGpu.onGpu(verdict("faster"), TurboGpu.AUTO));
        assertFalse(TurboGpu.onGpu(verdict("slower"), TurboGpu.AUTO));
        assertFalse(TurboGpu.onGpu(verdict(null), TurboGpu.AUTO));
    }

    @Test
    public void chosenGpuNeedsTheRightWordsNotSpeed() {
        assertTrue(TurboGpu.onGpu(verdict("slower"), TurboGpu.GPU));
        for (String bad : new String[] {"wrong", "failed", "crashed", "none", null}) {
            assertFalse(bad, TurboGpu.onGpu(verdict(bad), TurboGpu.GPU));
        }
        assertFalse(TurboGpu.onGpu(verdict("faster"), TurboGpu.CPU));
    }

    @Test
    public void webGpuIsTriedFirstThenVulkan() {
        assertEquals("WebGPU", TurboGpu.LEVELS[0].backend);
        assertTrue(TurboGpu.LEVELS[0].flash);
        assertEquals("Vulkan", TurboGpu.LEVELS[TurboGpu.LEVELS.length - 1].backend);
        assertFalse(TurboGpu.LEVELS[TurboGpu.LEVELS.length - 1].flash);
    }

    @Test
    public void aCheckThatNeverEndedIsCheckedAgainAnotherWay() {
        TurboGpu.Verdict v = verdict("testing");
        v.step = "probe";
        v = TurboGpu.settle(v, "build q8_0");
        assertNull(v.state);
        assertEquals(1, v.level);
        assertEquals("0:probe", v.crashed);
        while (v.level < TurboGpu.LEVELS.length - 1) {
            v.state = "testing";
            v.step = "gpu-shaders";
            v = TurboGpu.settle(v, "build q8_0");
        }
        v.state = "testing";
        v = TurboGpu.settle(v, "build q8_0");
        assertEquals("crashed", v.state);
        assertTrue(v.crashes.startsWith("0:probe 1:gpu-shaders 2:gpu-shaders "));
    }

    @Test
    public void wrongWordsAndReportedFailuresMoveOnToo() {
        TurboGpu.Verdict v = verdict("testing");
        TurboGpu.fail(v, "wrong", "wrong");
        assertNull(v.state);
        assertEquals(1, v.level);
        v.level = TurboGpu.LEVELS.length - 1;
        TurboGpu.fail(v, "gpu-run-hung", "failed");
        assertEquals("failed", v.state);
        assertTrue(v.crashes.endsWith((TurboGpu.LEVELS.length - 1) + ":gpu-run-hung "));
    }

    @Test
    public void twoGpuRunsDyingInARowFailTheirLevel() {
        TurboGpu.Verdict v = verdict("faster");
        v.running = true;
        v = TurboGpu.settle(v, "build q8_0");
        assertEquals("faster", v.state);
        assertEquals(1, v.deaths);
        assertNull(v.crashed);
        v.running = true;
        v = TurboGpu.settle(v, "build q8_0");
        assertNull(v.state);
        assertEquals(1, v.level);
        assertEquals("0:run", v.crashed);
        assertFalse(v.running);
    }

    @Test
    public void aVerdictFromAnEarlierLadderStartsOver() throws Exception {
        // The Galaxy S25 after build 252: ggml-vulkan's every level, wrong at the last.
        org.json.JSONObject old = new org.json.JSONObject().put("key", "build q8_0").put("state", "wrong").put("level", 4)
            .put("ladder", 3).put("gpu", "Adreno (TM) 830").put("crashes", "0:probe 1:gpu-shaders ");
        TurboGpu.Verdict v = TurboGpu.Verdict.of(old);
        assertNull(v.state);
        assertEquals(0, v.level);
        assertEquals("build q8_0", v.key);
        assertTrue(v.crashes.startsWith("ladder3:0:probe 1:gpu-shaders wrong"));
        // Of this ladder: kept as it is.
        TurboGpu.Verdict kept = verdict("crashed");
        kept.level = 3;
        TurboGpu.Verdict back = TurboGpu.Verdict.of(kept.json());
        assertEquals("crashed", back.state);
        assertEquals(3, back.level);
    }

    @Test
    public void devicesAreFoundByBackend() {
        String[] gpus = {"Vulkan0: Adreno (TM) 830", "WebGPU: Qualcomm Adreno (TM) 830"};
        assertEquals(1, TurboGpu.device(gpus, "WebGPU"));
        assertEquals(0, TurboGpu.device(gpus, "Vulkan"));
        assertEquals(-1, TurboGpu.device(new String[] {"Vulkan0: Mali-G715"}, "WebGPU"));
    }

    @Test
    public void anotherSystemBuildOrModelIsCheckedAgain() {
        TurboGpu.Verdict v = TurboGpu.settle(verdict("crashed"), "newer-build q8_0");
        assertNull(v.state);
        assertEquals("newer-build q8_0", v.key);
        assertNull(TurboGpu.settle(null, "build q5_1").state);
    }

    @Test
    public void verdictsSurviveBeingKept() throws Exception {
        TurboGpu.Verdict v = verdict("slower");
        v.gpu = "Adreno (TM) 830 · WebGPU";
        v.cpuSeconds = 9.5;
        v.deaths = 1;
        v.level = 1;
        v.step = "gpu-run";
        TurboGpu.Verdict back = TurboGpu.Verdict.of(v.json());
        assertEquals("slower", back.state);
        assertEquals("Adreno (TM) 830 · WebGPU", back.gpu);
        assertEquals(9.5, back.cpuSeconds, 0);
        assertEquals(1, back.deaths);
        assertEquals(1, back.level);
        assertEquals("gpu-run", back.step);
        assertEquals("WebGPU", v.json().getString("backend"));
        assertNull(TurboGpu.Verdict.of(verdict(null).json()).state);
    }

    @Test
    public void agreementCountsWordsInOrder() {
        assertEquals(1.0, TurboGpu.agreement("בפרק של היום, מתארחת", "בפרק של היום מתארחת."), 1e-9);
        assertEquals(0.75, TurboGpu.agreement("אחת שתיים שלוש ארבע", "אחת שתיים חמש ארבע"), 1e-9);
        assertEquals(0.0, TurboGpu.agreement("אחת", ""), 1e-9);
        assertEquals(1.0, TurboGpu.agreement("", ""), 1e-9);
        assertTrue(TurboGpu.agreement("אחת שתיים שלוש ארבע חמש שש שבע", "אחת שתיים שלוש ארבע חמש שש שמונה") >= TurboGpu.AGREEMENT);
    }
}
