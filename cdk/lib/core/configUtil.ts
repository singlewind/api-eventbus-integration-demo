export const requiredEnv = (varKey: string): string => {
  const varValue = process.env[varKey];

  if (!varValue) throw new Error(`${varKey} is required`);

  return varValue;
};

export const fromEnv = <K extends string>(
  requirements: Record<K, string>
): Record<K, string> => {
  return Object.keys(requirements).reduce<Record<K, string>>((acc, key) => {
    const value = requirements[key as K];
    return {
      ...acc,
      [key]: process.env[value],
    };
  }, {} as Record<K, string>);
};
