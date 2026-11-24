package ai.ivrit.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TurboTest {
    @Test
    public void galaxyS23AndOn() {
        for (String model : new String[] {"SM-S911B", "SM-S916U1", "SM-S918N", "SM-S711B", "SM-S921B", "SM-S928U",
                "SM-S721B", "SM-S931B", "SM-S937B", "SM-S938U", "SM-S731B", "SM-S942B"}) {
            assertTrue(model, Turbo.galaxy("samsung", model));
        }
        assertTrue(Turbo.galaxy("Samsung", "SM-S911B"));
    }

    @Test
    public void notOlderGalaxiesNorOtherPhones() {
        for (String model : new String[] {"SM-S901B", "SM-S908U", "SM-G991B", "SM-G990B", "SM-A546B", "SM-F946B",
                "SM-X910", "SM-S"}) {
            assertFalse(model, Turbo.galaxy("samsung", model));
        }
        assertFalse(Turbo.galaxy("Google", "SM-S911B"));
        assertFalse(Turbo.galaxy("samsung", null));
    }
}
