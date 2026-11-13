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
    public void aCheckThatNeverEndedIsACrash() {
        assertEquals("crashed", TurboGpu.settle(verdict("testing"), "build q8_0").state);
    }

    @Test
    public void twoGpuRunsDyingInARowGiveUpTheGpu() {
        TurboGpu.Verdict v = verdict("faster");
        v.running = true;
        v = TurboGpu.settle(v, "build q8_0");
        assertEquals("faster", v.state);
        assertEquals(1, v.deaths);
        v.running = true;
        v = TurboGpu.settle(v, "build q8_0");
        assertEquals("crashed", v.state);
        assertFalse(v.running);
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
        TurboGpu.Verdict back = TurboGpu.Verdict.of(v.json());
        assertEquals("slower", back.state);
        assertEquals("Adreno (TM) 720", back.gpu);
        assertEquals(9.5, back.cpuSeconds, 0);
        assertEquals(1, back.deaths);
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
