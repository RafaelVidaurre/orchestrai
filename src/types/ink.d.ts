declare module "ink" {
  import type { ReactElement, ReactNode } from "react";

  export interface Key {
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly escape?: boolean;
  }

  export interface BoxProps {
    children?: ReactNode;
    borderStyle?: string;
    borderColor?: string;
    flexDirection?: "row" | "column";
    padding?: number;
    paddingX?: number;
    paddingY?: number;
    marginTop?: number;
    marginBottom?: number;
    width?: number | string;
  }

  export interface TextProps {
    children?: ReactNode;
    color?: string;
  }

  export function Box(props: BoxProps): ReactElement;
  export function Text(props: TextProps): ReactElement;
  export function useApp(): {
    exit: () => void;
  };
  export function useInput(handler: (input: string, key: Key) => void): void;
  export function useStdout(): {
    stdout: NodeJS.WriteStream;
  };
  export function render(node: ReactNode): {
    waitUntilExit: () => Promise<void>;
  };
}
