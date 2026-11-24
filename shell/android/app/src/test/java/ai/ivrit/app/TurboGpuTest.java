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
    public void webGpuWithThePhoneProgramsAlone() {
        assertEquals(1, TurboGpu.LEVELS.length);
        assertEquals("WebGPU", TurboGpu.LEVELS[0].backend);
        assertTrue(TurboGpu.LEVELS[0].flash);
        java.util.List<String> env = java.util.Arrays.asList(TurboGpu.LEVELS[0].env);
        assertTrue(env.contains("GGML_WEBGPU_MOBILE"));
        assertTrue(env.contains("GGML_WEBGPU_DISABLE_SUBGROUPS"));
        assertTrue(env.contains("GGML_WEBGPU_SUBMIT_BATCH=8"));
        assertEquals(java.util.Arrays.asList("auto", "cpu", "gpu"), java.util.Arrays.asList(TurboGpu.PROCESSORS));
    }

    @Test
    public void aCheckThatNeverEndedGivesTheGpuUp() {
        TurboGpu.Verdict v = verdict("testing");
        v.step = "gpu-shaders";
        v = TurboGpu.settle(v, "build q8_0");
        assertEquals("crashed", v.state);
        assertEquals("0:gpu-shaders", v.crashed);
        assertFalse(TurboGpu.onGpu(v, TurboGpu.GPU));
    }

    @Test
    public void wrongWordsAndReportedFailuresGiveItUpToo() {
        TurboGpu.Verdict v = verdict("testing");
        TurboGpu.fail(v, "wrong", "wrong");
        assertEquals("wrong", v.state);
        v = verdict("faster");
        TurboGpu.fail(v, "gpu-run-hung", "failed");
        assertEquals("failed", v.state);
        assertTrue(v.crashes.endsWith("0:gpu-run-hung "));
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
        assertEquals("crashed", v.state);
        assertEquals("0:run", v.crashed);
        assertFalse(v.running);
    }

    @Test
    public void aVerdictFromAnEarlierLadderStartsOver() throws Exception {
        // Ladder 9's WebGPU level (Dawn's own programs), passed: checked again.
        org.json.JSONObject old = new org.json.JSONObject().put("key", "build q8_0").put("state", "faster").put("level", 1)
            .put("ladder", 9).put("gpu", "Adreno (TM) 830 · WebGPU").put("crashes", "0:gpu-run ");
        TurboGpu.Verdict v = TurboGpu.Verdict.of(old);
        assertNull(v.state);
        assertEquals(0, v.level);
        assertEquals("build q8_0", v.key);
        assertTrue(v.crashes.startsWith("ladder9:0:gpu-run faster"));
        // Of this ladder: kept as it is.
        TurboGpu.Verdict kept = verdict("crashed");
        TurboGpu.Verdict back = TurboGpu.Verdict.of(kept.json());
        assertEquals("crashed", back.state);
        assertEquals(0, back.level);
    }

    @Test
    public void devicesAreFoundByBackend() {
        String[] gpus = {"Vulkan0: Adreno (TM) 830", "WebGPU: WebGPU", "GPUOpenCL: QUALCOMM Adreno(TM) 830"};
        assertEquals(1, TurboGpu.device(gpus, "WebGPU"));
        assertEquals(0, TurboGpu.device(gpus, "Vulkan"));
        assertEquals(2, TurboGpu.device(gpus, "OpenCL"));
        assertEquals(-1, TurboGpu.device(new String[] {"Vulkan0: Mali-G715"}, "WebGPU"));
    }

    @Test
    public void anotherSystemBuildOrModelIsCheckedAgain() {
        TurboGpu.Verdict v = TurboGpu.settle(verdict("crashed"), "newer-build q8_0");
        assertNull(v.state);
        assertEquals("newer-build q8_0", v.key);
        assertNull(TurboGpu.settle(null, "build q4_0").state);
    }

    @Test
    public void verdictsSurviveBeingKept() throws Exception {
        TurboGpu.Verdict v = verdict("slower");
        v.gpu = "WebGPU: WebGPU · WebGPU";
        v.cpuSeconds = 9.5;
        v.deaths = 1;
        v.step = "gpu-run";
        TurboGpu.Verdict back = TurboGpu.Verdict.of(v.json());
        assertEquals("slower", back.state);
        assertEquals("WebGPU: WebGPU · WebGPU", back.gpu);
        assertEquals(9.5, back.cpuSeconds, 0);
        assertEquals(1, back.deaths);
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
