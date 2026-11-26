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
    public void paceIsTheWayItWouldRun() throws Exception {
        TurboGpu.Verdict v = verdict("faster");
        assertEquals(0, TurboGpu.pace(v, false), 0); // not timed
        v.cpuSeconds = 15;
        assertEquals(0, TurboGpu.pace(v, false), 0); // the recording's length not known
        v.sampleSeconds = 12;
        v.gpuSeconds = 6;
        v.splitSeconds = 4;
        assertEquals(1.25, TurboGpu.pace(v, false), 1e-9);
        assertEquals(0.5, TurboGpu.pace(v, true), 1e-9);
        v.decoderCpu = true;
        assertEquals(4 / 12.0, TurboGpu.pace(v, true), 1e-9);
        // Kept between runs.
        assertEquals(12, TurboGpu.Verdict.of(v.json()).sampleSeconds, 0);
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
    public void openClThenWebGpuWithThePhonePrograms() {
        assertEquals(2, TurboGpu.LEVELS.length);
        assertEquals("OpenCL", TurboGpu.LEVELS[0].backend);
        assertEquals(0, TurboGpu.LEVELS[0].env.length);
        assertEquals("WebGPU", TurboGpu.LEVELS[1].backend);
        java.util.List<String> env = java.util.Arrays.asList(TurboGpu.LEVELS[1].env);
        assertTrue(env.contains("GGML_WEBGPU_MOBILE"));
        assertTrue(env.contains("GGML_WEBGPU_DISABLE_SUBGROUPS"));
        assertTrue(env.contains("GGML_WEBGPU_SUBMIT_BATCH=8"));
        for (TurboGpu.Level level : TurboGpu.LEVELS) assertTrue(level.flash);
        assertEquals(java.util.Arrays.asList("auto", "cpu", "gpu"), java.util.Arrays.asList(TurboGpu.PROCESSORS));
    }

    @Test
    public void aCheckThatNeverEndedTriesWebGpuThenGivesTheGpuUp() {
        TurboGpu.Verdict v = verdict("testing");
        v.step = "probe";
        v = TurboGpu.settle(v, "build q8_0");
        assertNull(v.state);
        assertEquals(1, v.level);
        assertEquals("0:probe", v.crashed);
        v.state = "testing";
        v.step = "gpu-shaders";
        v = TurboGpu.settle(v, "build q8_0");
        assertEquals("crashed", v.state);
        assertEquals("1:gpu-shaders", v.crashed);
        assertTrue(v.crashes.startsWith("0:probe 1:gpu-shaders "));
        assertFalse(TurboGpu.onGpu(v, TurboGpu.GPU));
    }

    @Test
    public void theDecoderBesideTheGpuDyingChecksTheGpuAloneNext() {
        TurboGpu.Verdict v = verdict("testing");
        v.step = "gpu-split";
        assertFalse(TurboGpu.splitDied(v));
        v = TurboGpu.settle(v, "build q8_0");
        assertNull(v.state);
        assertEquals(0, v.level);
        assertNull(v.crashed);
        assertTrue(TurboGpu.splitDied(v));
        // Only at that level: WebGPU's check tries it again.
        v.level = 1;
        assertFalse(TurboGpu.splitDied(v));
        v.crashes = "ladder11:1:gpu-split ";
        assertFalse(TurboGpu.splitDied(v));
    }

    @Test
    public void rightWordsOnTheScreenRunOnTheGpuUntimed() {
        TurboGpu.Verdict v = verdict(null);
        assertFalse(TurboGpu.onGpu(v, TurboGpu.AUTO));
        v.passedOnScreen = true;
        assertTrue(TurboGpu.onGpu(v, TurboGpu.AUTO));
        assertTrue(TurboGpu.onGpu(v, TurboGpu.GPU));
        assertFalse(TurboGpu.onGpu(v, TurboGpu.CPU));
    }

    @Test
    public void build277sSlowerIsCheckedAgainItsOtherVerdictsHold() throws Exception {
        org.json.JSONObject slower = new org.json.JSONObject().put("key", "build q8_0").put("state", "slower")
            .put("ladder", 12).put("crashes", "");
        TurboGpu.Verdict v = TurboGpu.Verdict.of(slower);
        assertNull(v.state);
        assertTrue(v.crashes.startsWith("ladder12:slower"));
        TurboGpu.Verdict faster = TurboGpu.Verdict.of(slower.put("state", "faster"));
        assertEquals("faster", faster.state);
        assertEquals(TurboGpu.LADDER, faster.json().getInt("ladder"));
    }

    @Test
    public void wrongWordsAndReportedFailuresMoveOnToo() {
        TurboGpu.Verdict v = verdict("testing");
        TurboGpu.fail(v, "wrong", "wrong");
        assertNull(v.state);
        assertEquals(1, v.level);
        TurboGpu.fail(v, "gpu-run-hung", "failed");
        assertEquals("failed", v.state);
        assertTrue(v.crashes.endsWith("1:gpu-run-hung "));
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
        // Build 274's WebGPU level, passed: checked again, OpenCL first.
        org.json.JSONObject old = new org.json.JSONObject().put("key", "build q8_0").put("state", "faster").put("level", 0)
            .put("ladder", 11).put("gpu", "WebGPU: WebGPU · WebGPU").put("crashes", "0:gpu-run ");
        TurboGpu.Verdict v = TurboGpu.Verdict.of(old);
        assertNull(v.state);
        assertEquals(0, v.level);
        assertEquals("build q8_0", v.key);
        assertTrue(v.crashes.startsWith("ladder11:0:gpu-run faster"));
        // Of this ladder: kept as it is.
        TurboGpu.Verdict kept = verdict("crashed");
        kept.level = 1;
        TurboGpu.Verdict back = TurboGpu.Verdict.of(kept.json());
        assertEquals("crashed", back.state);
        assertEquals(1, back.level);
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
        v.cpuWords = "בפרק של היום";
        v.deaths = 1;
        v.level = 1;
        v.step = "gpu-run";
        TurboGpu.Verdict back = TurboGpu.Verdict.of(v.json());
        assertEquals("slower", back.state);
        assertEquals("WebGPU: WebGPU · WebGPU", back.gpu);
        assertEquals(9.5, back.cpuSeconds, 0);
        assertEquals("בפרק של היום", back.cpuWords);
        assertEquals(1, back.deaths);
        assertEquals(1, back.level);
        assertEquals("gpu-run", back.step);
        assertEquals("WebGPU", v.json().getString("backend"));
        assertNull(TurboGpu.Verdict.of(verdict(null).json()).state);
    }

    @Test
    public void coresAreCountedFromTheirList() {
        assertEquals(8, Turbo.countCores("0-7"));
        assertEquals(6, Turbo.countCores(" 0-5\n"));
        assertEquals(4, Turbo.countCores("0-1,4-5"));
        assertEquals(3, Turbo.countCores("0,2,7"));
        assertEquals(0, Turbo.countCores("x"));
        assertEquals(0, Turbo.fit(0));
        assertTrue(Turbo.fit(64) >= 1);
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
