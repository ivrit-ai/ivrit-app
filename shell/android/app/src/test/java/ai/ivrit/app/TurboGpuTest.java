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
    public void aCheckThatNeverEndedIsCheckedAgainMoreCarefully() {
        TurboGpu.Verdict v = verdict("testing");
        v.step = "probe";
        v = TurboGpu.settle(v, "build q8_0");
        assertNull(v.state);
        assertEquals(1, v.level);
        assertEquals("0:probe", v.crashed);
        for (int level = 1; level < TurboGpu.LEVELS.length; level++) {
            v.state = "testing";
            v.step = "gpu-shaders";
            v = TurboGpu.settle(v, "build q8_0");
        }
        assertEquals("crashed", v.state);
        assertEquals(TurboGpu.LEVELS.length - 1, v.level);
        assertEquals("0:probe 1:gpu-shaders 2:gpu-shaders 3:gpu-shaders ", v.crashes);
    }

    @Test
    public void twoGpuRunsDyingInARowAreACrash() {
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
    public void aCrashKeptBeforeLevelsIsTriedAgain() throws Exception {
        org.json.JSONObject old = new org.json.JSONObject().put("key", "build q8_0").put("state", "crashed").put("gpu", "");
        TurboGpu.Verdict v = TurboGpu.Verdict.of(old);
        assertNull(v.state);
        assertEquals(1, v.level);
        assertEquals("0:probe", v.crashed);
    }

    @Test
    public void aCrashAtBuild250sLastLevelGoesOnWithoutFlashAttention() throws Exception {
        org.json.JSONObject old = new org.json.JSONObject().put("key", "build q8_0").put("state", "crashed").put("level", 2)
            .put("gpu", "Adreno (TM) 830").put("crashes", "0:probe 1:gpu-shaders 2:gpu-shaders ");
        TurboGpu.Verdict v = TurboGpu.Verdict.of(old);
        assertNull(v.state);
        assertEquals(TurboGpu.NO_FLASH, v.level);
        assertFalse(TurboGpu.flash(v));
        assertEquals(TurboGpu.LADDER, TurboGpu.Verdict.of(v.json()).json().getInt("ladder"));
        // Kept at this ladder: a crash stays one.
        TurboGpu.Verdict kept = verdict("crashed");
        kept.level = 3;
        assertEquals("crashed", TurboGpu.Verdict.of(kept.json()).state);
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
        v.gpu = "Adreno (TM) 720";
        v.cpuSeconds = 9.5;
        v.deaths = 1;
        v.level = 1;
        v.step = "gpu-run";
        TurboGpu.Verdict back = TurboGpu.Verdict.of(v.json());
        assertEquals("slower", back.state);
        assertEquals("Adreno (TM) 720", back.gpu);
        assertEquals(9.5, back.cpuSeconds, 0);
        assertEquals(1, back.deaths);
        assertEquals(1, back.level);
        assertEquals("gpu-run", back.step);
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
